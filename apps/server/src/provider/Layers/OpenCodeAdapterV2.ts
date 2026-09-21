/**
 * OpenCodeAdapterV2 — provider adapter for the OpenCode 2 line (`/api/*`
 * server API, `@opencode/client`).
 *
 * Implements the same {@link OpenCodeAdapterShape} as the v1 adapter, but
 * speaks the v2 protocol natively:
 * - sessions are location-scoped (`location: { directory }` per request);
 * - model/agent/variant are session properties (`session.create`,
 *   `session.switchModel`, `session.switchAgent`), not per-prompt fields;
 * - `session.prompt` admits an inbox message and returns immediately; turn
 *   progress arrives as typed events (`session.text.delta`,
 *   `session.tool.called`, `session.execution.succeeded`, ...);
 * - interruptions go through `session.interrupt`;
 * - approvals arrive as `permission.asked` (replied via
 *   `session/{id}/permission/{requestID}/reply`);
 * - interactive questions arrive as `form.created` (answered via
 *   `session.form.reply`);
 * - one-shot text generation uses `session.generate` (see
 *   `textGeneration/OpenCodeTextGeneration.ts`).
 *
 * Resume cursors share the v1 shape (`{ schemaVersion: 1, sessionId }`), so
 * threads migrate across lines without losing their conversation.
 *
 * @module provider/Layers/OpenCodeAdapterV2
 */
import {
  EventId,
  type OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  type TurnTokenUsage,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import type { FormInfo, OpenCodeEvent, PermissionRequest } from "@opencode/client";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  OpenCodeApiVersionMismatchError,
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import {
  buildRuntimeInstructions,
  t3ToolAvailabilityFromCapabilities,
} from "../RuntimeInstructions.ts";
import { type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  buildOpenCodeV2PermissionRules,
  createOpenCodeV2Client,
  isOpenCodeAgentNotFoundError,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  parseOpenCodeModelSlug,
  runOpenCodeSdk,
  toOpenCodePermissionReply,
  toOpenCodeV2FileParts,
  type OpenCodeServerConnection,
  type OpenCodeV2Client,
} from "../opencodeRuntime.ts";
import {
  isSameOpenCodeDirectory,
  mergeOpenCodeAssistantText,
  type OpenCodeAdapterLiveOptions,
} from "./OpenCodeAdapter.ts";

const PROVIDER = ProviderDriverKind.make("opencode");

const isOpenCodeApiVersionMismatch = Schema.is(OpenCodeApiVersionMismatchError);

/**
 * Version tag stamped into the resume cursor. Shared with the v1 adapter so
 * cursors written by either line resume on either line.
 */
const OPENCODE_V2_RESUME_VERSION = 1 as const;

function parseOpenCodeV2Resume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE_V2_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

/**
 * Whether an error reports a missing session. v2 clients throw `ClientError`
 * shapes (`{ reason, cause: { status } }`); the walk covers those as well as
 * the v1 `{ response, status }` shapes. Only a confirmed miss may silently
 * start a fresh session.
 */
function isOpenCodeV2NotFound(cause: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== "object" || seen.has(node)) {
      continue;
    }
    seen.add(node);
    const record = node as Record<string, unknown>;
    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === "object"
        ? (response as { readonly status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === "number");
    if (statuses.includes(404)) {
      return true;
    }
    if (statuses.length > 0) {
      continue;
    }
    const name = record.name;
    if (typeof name === "string" && name.toLowerCase() === "notfounderror") {
      return true;
    }
    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return false;
}

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (normalized === "todowrite" || normalized === "todoread") {
    return "dynamic_tool_call";
  }
  if (
    normalized.includes("shell") ||
    normalized.includes("bash") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (
    normalized.includes("task") ||
    normalized.includes("agent") ||
    normalized.includes("subagent")
  ) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function mapV2PermissionToRequestType(
  action: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" {
  switch (action) {
    case "read":
      return "file_read_approval";
    case "edit":
      return "file_change_approval";
    default:
      return "command_execution_approval";
  }
}

function mapV2PermissionDecision(reply: "once" | "always" | "reject"): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

interface OpenCodeV2TextBuffer {
  text: string;
  emittedLength: number;
  completed: boolean;
}

interface OpenCodeV2ToolRecord {
  readonly toolId: string;
  readonly assistantMessageId: string;
  name: string;
  input: unknown;
}

interface OpenCodeV2TurnUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  steps: number;
}

interface OpenCodeV2SessionContext {
  session: ProviderSession;
  readonly client: OpenCodeV2Client;
  readonly server: OpenCodeServerConnection;
  readonly directory: string;
  openCodeSessionId: string;
  readonly relatedSessionIds: Set<string>;
  readonly pendingPermissions: Map<string, PermissionRequest>;
  readonly pendingForms: Map<string, FormInfo>;
  readonly emittedTerminalRequestIds: Set<string>;
  readonly textBuffers: Map<string, OpenCodeV2TextBuffer>;
  readonly reasoningBuffers: Map<string, OpenCodeV2TextBuffer>;
  readonly toolsById: Map<string, OpenCodeV2ToolRecord>;
  turnUsage: OpenCodeV2TurnUsage | undefined;
  hasSubagents: boolean;
  activeTurnId: TurnId | undefined;
  currentModel: string | undefined;
  currentAgent: string | undefined;
  currentVariant: string | undefined;
  commandNames: ReadonlyArray<string> | undefined;
  readonly promptSemaphore: Semaphore.Semaphore;
  readonly firstConnection: Deferred.Deferred<void, ProviderAdapterRequestError>;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toRequestError = (cause: OpenCodeRuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCodeRuntimeError.is(cause) ? cause.detail : openCodeRuntimeErrorDetail(cause),
    cause,
  });

type EventBaseInput = {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
};

function makeTurnUsage(): OpenCodeV2TurnUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    steps: 0,
  };
}

function takeTurnTokenUsage(context: OpenCodeV2SessionContext): TurnTokenUsage {
  const usage = context.turnUsage;
  context.turnUsage = undefined;
  if (!usage || usage.steps === 0) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: context.hasSubagents,
    };
  }
  return {
    usageStatus: "complete",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: context.hasSubagents,
  };
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

const OPENCODE_V2_DEFAULT_TITLE_PATTERN =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function normalizeV2FormQuestions(form: FormInfo): ReadonlyArray<UserInputQuestion> {
  return (form.fields ?? []).map((field) => {
    const kind = field as {
      readonly key?: unknown;
      readonly title?: unknown;
      readonly description?: unknown;
      readonly type?: unknown;
      readonly options?: ReadonlyArray<{ value?: unknown; label?: unknown; description?: unknown }>;
    };
    const key = typeof kind.key === "string" && kind.key.length > 0 ? kind.key : form.id;
    const title = typeof kind.title === "string" && kind.title.length > 0 ? kind.title : key;
    const description =
      typeof kind.description === "string" && kind.description.length > 0
        ? kind.description
        : title;
    return {
      id: key,
      header: title,
      question: description,
      options: (kind.options ?? []).map((option) => ({
        label: typeof option.label === "string" ? option.label : String(option.value ?? ""),
        description: typeof option.description === "string" ? option.description : "",
        ...(typeof option.value === "string" ? { value: option.value } : {}),
      })),
      ...(kind.type === "multiselect" ? { multiSelect: true } : {}),
    };
  });
}

function toV2FormAnswer(
  form: FormInfo,
  answers: Record<string, unknown>,
): Record<string, string | number | boolean | ReadonlyArray<string>> {
  const result: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  for (const field of form.fields ?? []) {
    const kind = field as {
      readonly key?: unknown;
      readonly title?: unknown;
      readonly description?: unknown;
      readonly type?: unknown;
    };
    if (typeof kind.key !== "string") {
      continue;
    }
    const raw =
      answers[kind.key] ??
      (typeof kind.title === "string" ? answers[kind.title] : undefined) ??
      (typeof kind.description === "string" ? answers[kind.description] : undefined);
    if (raw === undefined || raw === null) {
      continue;
    }
    if (kind.type === "multiselect") {
      const values = (Array.isArray(raw) ? raw : [raw]).filter(
        (value): value is string => typeof value === "string",
      );
      result[kind.key] = values;
      continue;
    }
    if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
      result[kind.key] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      const first = raw.find(
        (value): value is string | number | boolean =>
          typeof value === "string" || typeof value === "number" || typeof value === "boolean",
      );
      if (first !== undefined) {
        result[kind.key] = first;
      }
    }
  }
  return result;
}

export function makeOpenCodeAdapterV2(
  openCodeSettings: OpenCodeSettings,
  options?: OpenCodeAdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode");
    const serverConfig = yield* ServerConfig;
    const openCodeRuntime = yield* OpenCodeRuntime;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sameDirectory = (left: string, right: string) =>
      isSameOpenCodeDirectory(fileSystem, path, left, right);
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCodeV2SessionContext>();
    const deleteContextIfCurrent = (context: OpenCodeV2SessionContext) => {
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
    };

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode runtime identifier.",
            cause,
          }),
      ),
    );

    const buildEventBase = (input: EventBaseInput) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopV2Context(context)), {
          concurrency: "unbounded",
          discard: true,
        });
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const emitUnsafe = (event: ProviderRuntimeEvent) => {
      Queue.offerUnsafe(runtimeEvents, event);
    };
    const writeNativeEvent = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);
    const writeNativeEventBestEffort = (
      threadId: ThreadId,
      event: {
        readonly observedAt: string;
        readonly event: Record<string, unknown>;
      },
    ) => writeNativeEvent(threadId, event).pipe(Effect.catchCause(() => Effect.void));

    const ensureV2SessionContext = Effect.fn("ensureV2SessionContext")(function* (
      threadId: ThreadId,
    ) {
      const session = sessions.get(threadId);
      if (!session) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER,
          threadId,
        });
      }
      if (yield* Ref.get(session.stopped)) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId,
        });
      }
      return session;
    });

    const updateV2Session = Effect.fn("updateV2Session")(function* (
      context: OpenCodeV2SessionContext,
      patch: Partial<ProviderSession>,
      options?: { readonly clearActiveTurnId?: boolean; readonly clearLastError?: boolean },
    ) {
      const updatedAt = yield* nowIso;
      const nextSession = { ...context.session, ...patch, updatedAt } as ProviderSession &
        Record<string, unknown>;
      const mutableSession = nextSession as Record<string, unknown>;
      if (options?.clearActiveTurnId) {
        delete mutableSession.activeTurnId;
      }
      if (options?.clearLastError) {
        delete mutableSession.lastError;
      }
      context.session = nextSession;
      return nextSession;
    });

    const stopV2Context = Effect.fn("stopV2Context")(function* (context: OpenCodeV2SessionContext) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return false;
      }
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode session stopped before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      yield* runOpenCodeSdk("session.interrupt", (signal) =>
        context.client.session.interrupt({ sessionID: context.openCodeSessionId }, { signal }),
      ).pipe(Effect.timeout("1 second"), Effect.ignore);
      yield* Scope.close(context.sessionScope, Exit.void);
      return true;
    });

    const completeV2Turn = Effect.fn("completeV2Turn")(function* (
      context: OpenCodeV2SessionContext,
      turnId: TurnId,
      raw: unknown,
      outcome: { readonly state: "completed" | "failed"; readonly errorMessage?: string },
    ) {
      if (context.activeTurnId !== turnId) {
        return;
      }
      const tokenUsage = takeTurnTokenUsage(context);
      context.activeTurnId = undefined;
      yield* updateV2Session(context, { status: "ready" }, { clearActiveTurnId: true });
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          raw,
        })),
        type: "turn.completed",
        payload: {
          state: outcome.state,
          tokenUsage,
          ...(outcome.errorMessage ? { errorMessage: outcome.errorMessage } : {}),
        },
      });
    });

    const abortV2Turn = Effect.fn("abortV2Turn")(function* (
      context: OpenCodeV2SessionContext,
      turnId: TurnId,
      reason: string,
      raw?: unknown,
    ) {
      if (context.activeTurnId !== turnId) {
        return;
      }
      const tokenUsage = takeTurnTokenUsage(context);
      context.activeTurnId = undefined;
      yield* updateV2Session(
        context,
        { status: "ready" },
        { clearActiveTurnId: true, clearLastError: true },
      );
      yield* emit({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId,
          ...(raw !== undefined ? { raw } : {}),
        })),
        type: "turn.aborted",
        payload: { reason, tokenUsage },
      });
    });

    const openV2PermissionRequest = Effect.fn("openV2PermissionRequest")(function* (
      context: OpenCodeV2SessionContext,
      request: PermissionRequest,
      raw: unknown,
    ) {
      if (
        (yield* Ref.get(context.stopped)) ||
        context.emittedTerminalRequestIds.has(request.id) ||
        context.pendingPermissions.has(request.id)
      ) {
        return;
      }
      const resources = request.resources.filter((resource) => resource !== "*");
      const detail = [request.action.replaceAll("_", " "), ...resources].join("\n");
      context.pendingPermissions.set(request.id, request);
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: request.id,
          raw,
        })),
        type: "request.opened",
        payload: {
          requestType: mapV2PermissionToRequestType(request.action),
          detail,
          ...(request.metadata !== undefined ? { args: request.metadata } : {}),
          options: [
            { decision: "accept", label: "Allow once" },
            {
              decision: "acceptForSession",
              label: "Allow for workspace",
              warning: "Applies to matching requests in other OpenCode sessions in this workspace.",
            },
            { decision: "decline", label: "Deny" },
          ],
        },
      });
    });

    const autoReplyV2FullAccess = Effect.fn("autoReplyV2FullAccess")(function* (
      context: OpenCodeV2SessionContext,
      request: PermissionRequest,
    ) {
      // Full access pre-approves everything, but doom-loop style asks never
      // consult the session ruleset. Reply "once" (never "always"): an
      // "always" grant is stored per directory, so on a shared external
      // server it would silently widen a supervised thread's permissions.
      yield* runOpenCodeSdk("permission.reply", (signal) =>
        context.client.permission.reply(
          { sessionID: request.sessionID, requestID: request.id, decision: "once" },
          { signal },
        ),
      ).pipe(Effect.timeout("10 seconds"), Effect.ignore);
      context.pendingPermissions.delete(request.id);
      context.emittedTerminalRequestIds.add(request.id);
    });

    const openV2FormRequest = Effect.fn("openV2FormRequest")(function* (
      context: OpenCodeV2SessionContext,
      form: FormInfo,
      raw: unknown,
    ) {
      if (
        (yield* Ref.get(context.stopped)) ||
        context.emittedTerminalRequestIds.has(form.id) ||
        context.pendingForms.has(form.id)
      ) {
        return;
      }
      context.pendingForms.set(form.id, form);
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: form.id,
          raw,
        })),
        type: "user-input.requested",
        payload: { questions: normalizeV2FormQuestions(form) },
      });
    });

    const resolveV2PermissionReply = Effect.fn("resolveV2PermissionReply")(function* (
      context: OpenCodeV2SessionContext,
      requestID: string,
      reply: "once" | "always" | "reject",
      raw: unknown,
    ) {
      if (context.emittedTerminalRequestIds.has(requestID)) {
        return;
      }
      context.emittedTerminalRequestIds.add(requestID);
      const request = context.pendingPermissions.get(requestID);
      context.pendingPermissions.delete(requestID);
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: requestID,
          raw,
        })),
        type: "request.resolved",
        payload: {
          requestType: request ? mapV2PermissionToRequestType(request.action) : "unknown",
          decision: mapV2PermissionDecision(reply),
        },
      });
    });

    const resolveV2FormReply = Effect.fn("resolveV2FormReply")(function* (
      context: OpenCodeV2SessionContext,
      formID: string,
      answers: Record<string, unknown>,
      raw: unknown,
    ) {
      if (context.emittedTerminalRequestIds.has(formID)) {
        return;
      }
      context.emittedTerminalRequestIds.add(formID);
      const form = context.pendingForms.get(formID);
      context.pendingForms.delete(formID);
      const resolved: Record<string, string> = {};
      if (form) {
        for (const question of normalizeV2FormQuestions(form)) {
          const value: unknown = answers[question.id];
          resolved[question.id] = Array.isArray(value)
            ? value.map((entry) => String(entry)).join(", ")
            : String(value ?? "");
        }
      }
      emitUnsafe({
        ...(yield* buildEventBase({
          threadId: context.session.threadId,
          turnId: context.activeTurnId,
          requestId: formID,
          raw,
        })),
        type: "user-input.resolved",
        payload: { answers: resolved },
      });
    });

    const lookupV2ToolName = (
      context: OpenCodeV2SessionContext,
      assistantMessageId: string,
      toolId: string,
    ): Effect.Effect<string> =>
      runOpenCodeSdk("session.message.get", (signal) =>
        context.client.session.message.get(
          { sessionID: context.openCodeSessionId, messageID: assistantMessageId },
          { signal },
        ),
      ).pipe(
        Effect.timeout("5 seconds"),
        Effect.map((message) => {
          if (message.type !== "assistant") {
            return "tool";
          }
          const match = message.content.find(
            (entry) => entry.type === "tool" && entry.id === toolId,
          );
          return match && match.type === "tool" ? match.name : "tool";
        }),
        Effect.orElseSucceed(() => "tool"),
      );

    const emitUnexpectedV2Exit = Effect.fn("emitUnexpectedV2Exit")(function* (
      context: OpenCodeV2SessionContext,
      message: string,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode session exited before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      const turnId = context.activeTurnId;
      context.activeTurnId = undefined;
      deleteContextIfCurrent(context);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "runtime.error",
        payload: { message, class: "transport_error" },
      }).pipe(Effect.ignore);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "session.exited",
        payload: { reason: message, recoverable: false, exitKind: "error" },
      }).pipe(Effect.ignore);
      yield* runOpenCodeSdk("session.interrupt", (signal) =>
        context.client.session.interrupt({ sessionID: context.openCodeSessionId }, { signal }),
      ).pipe(Effect.timeout("1 second"), Effect.ignore);
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    const isoFromCreated = (created: number): string | undefined =>
      DateTime.make(created).pipe(
        Option.match({
          onNone: () => undefined,
          onSome: DateTime.formatIso,
        }),
      );

    const handleV2Event = Effect.fn("handleV2Event")(function* (
      context: OpenCodeV2SessionContext,
      event: OpenCodeEvent,
    ) {
      const raw = event;
      yield* writeNativeEventBestEffort(context.session.threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId: context.session.threadId,
          providerThreadId: context.openCodeSessionId,
          type: event.type,
          payload: event,
        },
      });
      if (event.type === "server.connected") {
        yield* Deferred.succeed(context.firstConnection, undefined).pipe(Effect.ignore);
        yield* updateV2Session(context, { status: "ready" });
        return;
      }
      const data = (event as { data?: { sessionID?: unknown } }).data;
      const eventSessionId =
        typeof data?.sessionID === "string" ? (data.sessionID as string) : undefined;
      if (eventSessionId !== undefined && !context.relatedSessionIds.has(eventSessionId)) {
        if (event.type === "session.created") {
          const parentID = (event.data as { parentID?: unknown }).parentID;
          if (typeof parentID === "string" && context.relatedSessionIds.has(parentID)) {
            context.relatedSessionIds.add(eventSessionId);
            context.hasSubagents = true;
          }
          return;
        }
        return;
      }
      const turnId = context.activeTurnId;
      const createdAt = isoFromCreated((event as { created: number }).created);

      const base = (extra?: { readonly itemId?: string; readonly requestId?: string }) =>
        buildEventBase({
          threadId: context.session.threadId,
          ...(turnId ? { turnId } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...(extra?.itemId ? { itemId: extra.itemId } : {}),
          ...(extra?.requestId ? { requestId: extra.requestId } : {}),
          raw,
        });

      switch (event.type) {
        case "session.created":
          yield* Deferred.succeed(context.firstConnection, undefined).pipe(Effect.ignore);
          break;
        case "session.renamed": {
          const title = trimText(event.data.title);
          if (title && !OPENCODE_V2_DEFAULT_TITLE_PATTERN.test(title)) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.session.threadId, raw })),
              type: "thread.metadata.updated",
              payload: { name: title, metadata: { sessionID: context.openCodeSessionId } },
            });
          }
          break;
        }
        case "session.text.started": {
          context.textBuffers.set(event.data.assistantMessageID, {
            text: "",
            emittedLength: 0,
            completed: false,
          });
          yield* Deferred.succeed(context.firstConnection, undefined).pipe(Effect.ignore);
          break;
        }
        case "session.text.delta": {
          let buffer = context.textBuffers.get(event.data.assistantMessageID);
          if (!buffer) {
            buffer = { text: "", emittedLength: 0, completed: false };
            context.textBuffers.set(event.data.assistantMessageID, buffer);
          }
          const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(
            buffer.text,
            buffer.text + event.data.delta,
          );
          buffer.text = latestText;
          if (deltaToEmit.length > 0) {
            buffer.emittedLength = latestText.length;
            yield* emit({
              ...(yield* base({ itemId: event.data.assistantMessageID })),
              type: "content.delta",
              payload: { streamKind: "assistant_text" as const, delta: deltaToEmit },
            });
          }
          break;
        }
        case "session.text.ended": {
          const buffer = context.textBuffers.get(event.data.assistantMessageID);
          const text = buffer?.text ?? event.data.text ?? "";
          if (buffer) {
            buffer.completed = true;
          }
          if (text.length > 0) {
            yield* emit({
              ...(yield* base({ itemId: event.data.assistantMessageID })),
              type: "item.completed",
              payload: {
                itemType: "assistant_message" as const,
                status: "completed" as const,
                title: "Assistant message",
                detail: text,
              },
            });
          }
          break;
        }
        case "session.reasoning.started": {
          context.reasoningBuffers.set(event.data.assistantMessageID, {
            text: "",
            emittedLength: 0,
            completed: false,
          });
          break;
        }
        case "session.reasoning.delta": {
          let buffer = context.reasoningBuffers.get(event.data.assistantMessageID);
          if (!buffer) {
            buffer = { text: "", emittedLength: 0, completed: false };
            context.reasoningBuffers.set(event.data.assistantMessageID, buffer);
          }
          const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(
            buffer.text,
            buffer.text + event.data.delta,
          );
          buffer.text = latestText;
          if (deltaToEmit.length > 0) {
            buffer.emittedLength = latestText.length;
            yield* emit({
              ...(yield* base({ itemId: event.data.assistantMessageID })),
              type: "content.delta",
              payload: { streamKind: "reasoning_text" as const, delta: deltaToEmit },
            });
          }
          break;
        }
        case "session.reasoning.ended": {
          const buffer = context.reasoningBuffers.get(event.data.assistantMessageID);
          if (buffer) {
            buffer.completed = true;
          }
          break;
        }
        case "session.step.ended": {
          if (turnId === undefined) {
            break;
          }
          const usage = (context.turnUsage ??= makeTurnUsage());
          usage.steps += 1;
          usage.inputTokens +=
            event.data.tokens.input + event.data.tokens.cache.read + event.data.tokens.cache.write;
          usage.cachedInputTokens += event.data.tokens.cache.read;
          usage.cacheCreationTokens += event.data.tokens.cache.write;
          usage.outputTokens += event.data.tokens.output + event.data.tokens.reasoning;
          usage.reasoningTokens += event.data.tokens.reasoning;
          break;
        }
        case "session.tool.called": {
          const name = yield* lookupV2ToolName(
            context,
            event.data.assistantMessageID,
            event.data.id,
          );
          context.toolsById.set(event.data.id, {
            toolId: event.data.id,
            assistantMessageId: event.data.assistantMessageID,
            name,
            input: event.data.input,
          });
          const itemType = toToolLifecycleItemType(name);
          yield* emit({
            ...(yield* base({ itemId: event.data.id })),
            type: "item.started",
            payload: {
              itemType,
              status: "inProgress" as const,
              title: name,
              ...(itemType === "command_execution" || itemType === "file_change"
                ? { input: event.data.input }
                : {}),
              data: { tool: name },
            },
          });
          break;
        }
        case "session.tool.success":
        case "session.tool.failed": {
          const record = context.toolsById.get(event.data.id);
          const name = record?.name ?? "tool";
          const itemType = toToolLifecycleItemType(name);
          const detail =
            event.type === "session.tool.failed"
              ? event.data.error.message
              : (event.data.content ?? [])
                  .filter((entry) => entry.type === "text")
                  .map((entry) => (entry.type === "text" ? entry.text : ""))
                  .join("")
                  .slice(0, 4000) || undefined;
          yield* emit({
            ...(yield* base({ itemId: event.data.id })),
            type: "item.completed",
            payload: {
              itemType,
              status:
                event.type === "session.tool.failed" ? ("failed" as const) : ("completed" as const),
              title: name,
              ...(detail ? { detail } : {}),
              data: { tool: name },
            },
          });
          break;
        }
        case "session.execution.started": {
          if (turnId !== undefined) {
            yield* updateV2Session(context, { status: "running", activeTurnId: turnId });
          }
          break;
        }
        case "session.execution.succeeded": {
          if (turnId !== undefined) {
            yield* completeV2Turn(context, turnId, raw, { state: "completed" });
          }
          break;
        }
        case "session.execution.failed": {
          if (turnId !== undefined) {
            yield* completeV2Turn(context, turnId, raw, {
              state: "failed",
              errorMessage: event.data.error.message,
            });
          } else {
            yield* updateV2Session(context, {
              status: "error",
              lastError: event.data.error.message,
            });
          }
          break;
        }
        case "session.execution.interrupted": {
          if (turnId !== undefined) {
            const reason =
              event.data.reason === "user"
                ? "Interrupted by user."
                : `Execution interrupted (${event.data.reason}).`;
            yield* abortV2Turn(context, turnId, reason, raw);
          }
          break;
        }
        case "session.idle": {
          if (turnId === undefined) {
            break;
          }
          // Fallback completion: execution events normally settle the turn.
          // When only idle arrives, confirm against the active-session map —
          // a session still listed there is genuinely busy, so leave it.
          const active = yield* runOpenCodeSdk("session.active", (signal) =>
            context.client.session.active({ signal }),
          ).pipe(Effect.timeout("5 seconds"), Effect.option);
          if (active._tag === "None") {
            break;
          }
          if (active.value[context.openCodeSessionId] === undefined) {
            yield* completeV2Turn(context, turnId, raw, { state: "completed" });
          }
          break;
        }
        case "permission.asked": {
          if (context.session.runtimeMode === "full-access") {
            yield* autoReplyV2FullAccess(context, event.data).pipe(
              Effect.forkIn(context.sessionScope),
            );
            break;
          }
          yield* openV2PermissionRequest(context, event.data, raw);
          break;
        }
        case "permission.replied": {
          yield* resolveV2PermissionReply(context, event.data.requestID, event.data.reply, raw);
          break;
        }
        case "form.created": {
          yield* openV2FormRequest(context, event.data.form, raw);
          break;
        }
        case "form.replied": {
          yield* resolveV2FormReply(context, event.data.id, event.data.answer, raw);
          break;
        }
        case "form.cancelled": {
          yield* resolveV2FormReply(context, event.data.id, {}, raw);
          break;
        }
        case "session.compaction.ended": {
          yield* emit({
            ...(yield* base()),
            type: "thread.state.changed",
            payload: { state: "compacted", detail: event },
          });
          break;
        }
        default:
          break;
      }
    });

    const startV2EventPump = Effect.fn("startV2EventPump")(function* (
      context: OpenCodeV2SessionContext,
    ) {
      const eventsAbortController = new AbortController();
      yield* Scope.addFinalizer(
        context.sessionScope,
        Effect.sync(() => eventsAbortController.abort()),
      );
      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedV2Exit(
                context,
                `OpenCode server exited unexpectedly (${code}).`,
              );
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
      const subscribe = Effect.try({
        try: () => context.client.event.subscribe({ signal: eventsAbortController.signal }),
        catch: (cause) =>
          new OpenCodeRuntimeError({
            operation: "event.subscribe",
            detail: openCodeRuntimeErrorDetail(cause),
            cause,
          }),
      });
      yield* subscribe.pipe(
        Effect.flatMap((iterable) =>
          Stream.fromAsyncIterable(
            iterable,
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "event.subscribe",
                detail: openCodeRuntimeErrorDetail(cause),
                cause,
              }),
          ).pipe(Stream.runForEach((event) => handleV2Event(context, event))),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
              return;
            }
            yield* emitUnexpectedV2Exit(
              context,
              Exit.isFailure(exit)
                ? openCodeRuntimeErrorDetail(Cause.squash(exit.cause))
                : "OpenCode event stream ended unexpectedly. Send another message to reconnect.",
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );
    });

    const applyV2SessionSelection = Effect.fn("applyV2SessionSelection")(function* (
      client: OpenCodeV2SessionContext["client"],
      sessionID: string,
      selection: {
        readonly parsedSelection: { readonly providerID: string; readonly modelID: string } | null;
        readonly selectedAgent?: string;
        readonly selectedVariant?: string;
      },
    ) {
      if (selection.parsedSelection) {
        yield* runOpenCodeSdk("session.switchModel", (signal) =>
          client.session.switchModel(
            {
              sessionID,
              model: {
                id: selection.parsedSelection!.modelID,
                providerID: selection.parsedSelection!.providerID,
                ...(selection.selectedVariant ? { variant: selection.selectedVariant } : {}),
              },
            },
            { signal },
          ),
        ).pipe(Effect.mapError(toRequestError));
      }
      if (selection.selectedAgent) {
        const requestedAgent = selection.selectedAgent;
        yield* runOpenCodeSdk("session.switchAgent", (signal) =>
          client.session.switchAgent({ sessionID, agent: requestedAgent }, { signal }),
        ).pipe(
          Effect.asVoid,
          Effect.catchIf(
            (cause) => isOpenCodeAgentNotFoundError(cause),
            (cause) =>
              // A stale client selection (e.g. a display label like "Build")
              // must not kill the turn: keep the session's current agent.
              Effect.logWarning(
                `OpenCode session '${sessionID}' ignores unknown agent '${requestedAgent}'; continuing with its current agent: ${openCodeRuntimeErrorDetail(cause)}`,
              ),
          ),
          Effect.mapError(toRequestError),
        );
      }
    });

    const closeStartingV2Context = Effect.fn("closeStartingV2Context")(function* (
      context: OpenCodeV2SessionContext,
      interruptRemote: boolean,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      yield* Deferred.fail(
        context.firstConnection,
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "event.subscribe",
          detail: "OpenCode session startup ended before the event stream connected.",
        }),
      ).pipe(Effect.ignore);
      if (interruptRemote) {
        yield* runOpenCodeSdk("session.interrupt", (signal) =>
          context.client.session.interrupt({ sessionID: context.openCodeSessionId }, { signal }),
        ).pipe(Effect.timeout("1 second"), Effect.ignore);
      }
      yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
    });

    const awaitV2ContextReady = Effect.fn("awaitV2ContextReady")(function* (
      context: OpenCodeV2SessionContext,
    ) {
      yield* Deferred.await(context.firstConnection);
      const current = yield* ensureV2SessionContext(context.session.threadId);
      if (current !== context) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER,
          threadId: context.session.threadId,
        });
      }
      return current;
    });

    const startSession: OpenCodeAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCodeSettings.binaryPath;
        const serverUrl = openCodeSettings.serverUrl;
        const serverPassword = openCodeSettings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCodeV2Resume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          if (existing.session.status === "connecting" && !(yield* Ref.get(existing.stopped))) {
            return (yield* awaitV2ContextReady(existing)).session;
          }
          yield* stopV2Context(existing);
          deleteContextIfCurrent(existing);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              const server = yield* openCodeRuntime.connectToOpenCodeServer({
                binaryPath,
                directory,
                serverUrl,
                ...(serverPassword ? { serverPassword } : {}),
                ...(options?.managedDir !== undefined ? { managedDir: options.managedDir } : {}),
                environment: McpProviderSession.withAgentComputerEnvironment(
                  McpProviderSession.withAgentDeviceEnvironment(
                    options?.environment ?? process.env,
                    mcpSession,
                  ),
                  mcpSession,
                ),
              });
              if (server.apiVersion !== 2) {
                return yield* new OpenCodeApiVersionMismatchError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  actual: server.apiVersion,
                });
              }
              const client = createOpenCodeV2Client({
                baseUrl: server.url,
                ...(server.serverPassword ? { serverPassword: server.serverPassword } : {}),
              });
              if (mcpSession && !server.external) {
                yield* runOpenCodeSdk("mcp.add", () =>
                  client.mcp.add({
                    server: "t3-code",
                    location: { directory },
                    config: {
                      type: "remote",
                      url: mcpSession.endpoint,
                      headers: { Authorization: mcpSession.authorizationHeader },
                      oauth: false,
                    },
                  }),
                );
              }
              const selectedAgent = getModelSelectionStringOptionValue(
                input.modelSelection,
                "agent",
              );
              const selectedVariant = getModelSelectionStringOptionValue(
                input.modelSelection,
                "variant",
              );
              const parsedSelection = parseOpenCodeModelSlug(input.modelSelection?.model);

              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId
                  ? yield* runOpenCodeSdk("session.get", (signal) =>
                      client.session.get({ sessionID: resumeSessionId }, { signal }),
                    ).pipe(
                      Effect.catchIf(
                        (cause) => isOpenCodeV2NotFound(cause),
                        () => Effect.succeed(undefined),
                      ),
                    )
                  : undefined;

                const reusable =
                  adopted &&
                  (!adopted.location?.directory ||
                    (yield* sameDirectory(adopted.location.directory, directory)))
                    ? adopted
                    : undefined;

                if (reusable) {
                  yield* runOpenCodeSdk("session.update", (signal) =>
                    client.session.update(
                      {
                        sessionID: reusable.id,
                        permissions: buildOpenCodeV2PermissionRules(input.runtimeMode),
                      },
                      { signal },
                    ),
                  );
                  // Resume skips `session.create`, so re-assert the requested
                  // model/agent — a model change would otherwise leave the
                  // session on its original selection.
                  yield* applyV2SessionSelection(client, reusable.id, {
                    parsedSelection,
                    ...(selectedAgent ? { selectedAgent } : {}),
                    ...(selectedVariant ? { selectedVariant } : {}),
                  });
                  return { openCodeSessionId: reusable.id, created: false };
                }

                if (adopted) {
                  yield* Effect.logInfo(
                    `OpenCode session '${adopted.id}' lives in a different directory; moving into '${directory}' to preserve conversation history.`,
                  );
                  yield* runOpenCodeSdk("session.move", (signal) =>
                    client.session.move({ sessionID: adopted.id, directory }, { signal }),
                  );
                  yield* runOpenCodeSdk("session.update", (signal) =>
                    client.session.update(
                      {
                        sessionID: adopted.id,
                        permissions: buildOpenCodeV2PermissionRules(input.runtimeMode),
                      },
                      { signal },
                    ),
                  );
                  yield* applyV2SessionSelection(client, adopted.id, {
                    parsedSelection,
                    ...(selectedAgent ? { selectedAgent } : {}),
                    ...(selectedVariant ? { selectedVariant } : {}),
                  });
                  return { openCodeSessionId: adopted.id, created: false };
                }

                if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }
                const createSession = (agent: string | undefined) =>
                  runOpenCodeSdk("session.create", (signal) =>
                    client.session.create(
                      {
                        ...(input.title ? { title: input.title } : {}),
                        ...(agent ? { agent } : {}),
                        ...(parsedSelection
                          ? {
                              model: {
                                id: parsedSelection.modelID,
                                providerID: parsedSelection.providerID,
                                ...(selectedVariant ? { variant: selectedVariant } : {}),
                              },
                            }
                          : {}),
                        location: { directory },
                        permissions: buildOpenCodeV2PermissionRules(input.runtimeMode),
                      },
                      { signal },
                    ),
                  );
                const created = yield* createSession(selectedAgent).pipe(
                  Effect.catchIf(
                    (cause) => selectedAgent !== undefined && isOpenCodeAgentNotFoundError(cause),
                    (cause) =>
                      // A stale client selection (e.g. a display label like
                      // "Build") must not kill the turn: retry once with the
                      // server default agent.
                      Effect.logWarning(
                        `OpenCode server does not know agent '${selectedAgent}'; creating the session with its default agent instead: ${openCodeRuntimeErrorDetail(cause)}`,
                      ).pipe(Effect.flatMap(() => createSession(undefined))),
                  ),
                );
                return { openCodeSessionId: created.id, created: true };
              });

              return {
                sessionScope,
                server,
                client,
                openCodeSessionId: resolved.openCodeSessionId,
                created: resolved.created,
                selectedAgent,
                selectedVariant,
                parsedSelection,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            const squashed = Cause.squash(startedExit.cause);
            if (isOpenCodeApiVersionMismatch(squashed)) {
              return yield* squashed;
            }
            return yield* toProcessError(input.threadId, squashed);
          }
          return startedExit.value;
        });

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "connecting",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: OPENCODE_V2_RESUME_VERSION,
            sessionId: started.openCodeSessionId,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCodeV2SessionContext = {
          session,
          client: started.client,
          server: started.server,
          directory,
          openCodeSessionId: started.openCodeSessionId,
          relatedSessionIds: new Set([started.openCodeSessionId]),
          pendingPermissions: new Map(),
          pendingForms: new Map(),
          emittedTerminalRequestIds: new Set(),
          textBuffers: new Map(),
          reasoningBuffers: new Map(),
          toolsById: new Map(),
          turnUsage: undefined,
          hasSubagents: false,
          activeTurnId: undefined,
          currentModel: started.parsedSelection
            ? `${started.parsedSelection.providerID}/${started.parsedSelection.modelID}`
            : undefined,
          currentAgent: started.selectedAgent,
          currentVariant: started.selectedVariant,
          commandNames: undefined,
          promptSemaphore: Semaphore.makeUnsafe(1),
          firstConnection: Deferred.makeUnsafe<void, ProviderAdapterRequestError>(),
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          yield* closeStartingV2Context(context, started.created);
          return (yield* awaitV2ContextReady(raceWinner)).session;
        }
        sessions.set(input.threadId, context);
        const cleanupStartingContext = closeStartingV2Context(context, started.created).pipe(
          Effect.ensuring(Effect.sync(() => deleteContextIfCurrent(context))),
        );
        const connectionExit = yield* Effect.gen(function* () {
          yield* startV2EventPump(context);
          yield* Deferred.await(context.firstConnection).pipe(
            Effect.timeout("10 seconds"),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "event.subscribe",
                  detail: "OpenCode event stream did not connect within 10 seconds.",
                  cause,
                }),
            ),
          );
        }).pipe(
          Effect.onInterrupt(() => cleanupStartingContext),
          Effect.exit,
        );
        if (Exit.isFailure(connectionExit)) {
          yield* cleanupStartingContext;
          return yield* Effect.failCause(connectionExit.cause);
        }
        yield* awaitV2ContextReady(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: { message: "OpenCode session started" },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: { providerThreadId: started.openCodeSessionId },
        });

        return context.session;
      },
    );

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureV2SessionContext(input.threadId);
      yield* awaitV2ContextReady(context);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCodeModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode model selection must use the 'provider/model' format.",
        });
      }

      const text = input.input?.trim();
      const commandMatch = text?.match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
      if (context.commandNames === undefined) {
        context.commandNames = yield* runOpenCodeSdk("command.list", (signal) =>
          context.client.command.list({ location: { directory: context.directory } }, { signal }),
        ).pipe(
          Effect.map((result) => (result.data ?? []).map((command) => command.name)),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed((): ReadonlyArray<string> => []),
        );
      }
      const nativeCommand = commandMatch?.[1]
        ? context.commandNames.find((name) => name === commandMatch[1])
        : undefined;
      const fileParts = toOpenCodeV2FileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode turns require text input or at least one attachment.",
        });
      }

      return yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          if (sessions.get(input.threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* Effect.interrupt;
          }
          // A sendTurn while a turn is active steers the running session.
          const steeringTurnId = context.activeTurnId;
          const turnId = steeringTurnId ?? TurnId.make(`opencode-turn-${yield* randomUUIDv4}`);
          const agent = getModelSelectionStringOptionValue(modelSelection, "agent");
          const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

          const slug = `${parsedModel.providerID}/${parsedModel.modelID}`;
          if (slug !== context.currentModel || (variant ?? undefined) !== context.currentVariant) {
            yield* runOpenCodeSdk("session.switchModel", (signal) =>
              context.client.session.switchModel(
                {
                  sessionID: context.openCodeSessionId,
                  model: {
                    id: parsedModel.modelID,
                    providerID: parsedModel.providerID,
                    ...(variant ? { variant } : {}),
                  },
                },
                { signal },
              ),
            ).pipe(Effect.mapError(toRequestError));
            context.currentModel = slug;
            context.currentVariant = variant ?? undefined;
          }
          const effectiveAgent =
            agent ??
            (input.interactionMode === "plan" ? "plan" : undefined) ??
            context.currentAgent;
          if (effectiveAgent !== undefined && effectiveAgent !== context.currentAgent) {
            yield* runOpenCodeSdk("session.switchAgent", (signal) =>
              context.client.session.switchAgent(
                { sessionID: context.openCodeSessionId, agent: effectiveAgent },
                { signal },
              ),
            ).pipe(Effect.mapError(toRequestError));
            context.currentAgent = effectiveAgent;
          }

          context.activeTurnId = turnId;
          if (steeringTurnId === undefined) {
            context.turnUsage = makeTurnUsage();
          }
          yield* updateV2Session(
            context,
            {
              status: "running",
              activeTurnId: turnId,
              model: modelSelection?.model ?? context.session.model,
            },
            { clearLastError: true },
          );
          if (steeringTurnId === undefined) {
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.started",
              payload: { model: modelSelection?.model ?? context.session.model },
            });
          }

          // Harness briefing travels as a session instruction entry — v2
          // prompts take no system field. Best-effort: a rejected put must
          // not fail the turn.
          yield* runOpenCodeSdk("session.instructions.put", (signal) =>
            context.client.session.instructions.entry.put(
              {
                sessionID: context.openCodeSessionId,
                key: "t3-harness",
                value: buildRuntimeInstructions({
                  harness: "OpenCode",
                  model: slug,
                  t3Tools: t3ToolAvailabilityFromCapabilities(
                    McpProviderSession.readMcpProviderSession(input.threadId)?.capabilities,
                  ),
                }),
              },
              { signal },
            ),
          ).pipe(Effect.timeout("10 seconds"), Effect.ignore);

          const submissionMethod = nativeCommand ? "session.command" : "session.prompt";
          const submission = nativeCommand
            ? runOpenCodeSdk("session.command", (signal) =>
                context.client.session.command(
                  {
                    sessionID: context.openCodeSessionId,
                    name: nativeCommand,
                    text: commandMatch?.[2] ?? "",
                    ...(fileParts.length > 0
                      ? {
                          files: fileParts.map((part) => ({
                            uri: part.uri,
                            ...(part.name ? { name: part.name } : {}),
                          })),
                        }
                      : {}),
                  },
                  { signal },
                ),
              )
            : runOpenCodeSdk("session.prompt", (signal) =>
                context.client.session.prompt(
                  {
                    sessionID: context.openCodeSessionId,
                    text: text && text.length > 0 ? text : "(see attached files)",
                    ...(fileParts.length > 0
                      ? {
                          files: fileParts.map((part) => ({
                            uri: part.uri,
                            ...(part.name ? { name: part.name } : {}),
                          })),
                        }
                      : {}),
                  },
                  { signal },
                ),
              );
          const submissionExit = yield* submission.pipe(Effect.timeout("30 seconds"), Effect.exit);
          if (Exit.isFailure(submissionExit)) {
            if (
              (yield* Ref.get(context.stopped)) ||
              sessions.get(input.threadId) !== context ||
              context.activeTurnId !== turnId
            ) {
              return yield* Effect.interrupt;
            }
            const detail = openCodeRuntimeErrorDetail(Cause.squash(submissionExit.cause));
            const tokenUsage = takeTurnTokenUsage(context);
            context.activeTurnId = undefined;
            yield* updateV2Session(
              context,
              { status: "ready", model: modelSelection?.model ?? context.session.model },
              { clearActiveTurnId: true },
            );
            yield* emit({
              ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
              type: "turn.aborted",
              payload: { reason: detail, tokenUsage },
            });
            return yield* new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: submissionMethod,
              detail,
              cause: Cause.squash(submissionExit.cause),
            });
          }

          return {
            threadId: input.threadId,
            turnId,
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        }),
      );
    });

    const compactThread = Effect.fn("compactThread")(function* (
      threadId: ThreadId,
      requestedModelSelection?: ProviderSendTurnInput["modelSelection"],
    ) {
      const context = yield* ensureV2SessionContext(threadId);
      yield* awaitV2ContextReady(context);
      if (
        requestedModelSelection !== undefined &&
        requestedModelSelection.instanceId !== boundInstanceId
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "compactThread",
          issue: `OpenCode model selection is bound to instance '${requestedModelSelection.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      yield* context.promptSemaphore.withPermit(
        Effect.gen(function* () {
          if (sessions.get(threadId) !== context || (yield* Ref.get(context.stopped))) {
            return yield* Effect.interrupt;
          }
          if (context.activeTurnId !== undefined) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "compactThread",
              issue: "OpenCode cannot compact while a turn is running.",
            });
          }
          yield* runOpenCodeSdk("session.compact", (signal) =>
            context.client.session.compact({ sessionID: context.openCodeSessionId }, { signal }),
          ).pipe(
            Effect.timeout("10 minutes"),
            Effect.catchTags({
              OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
              TimeoutError: (cause) =>
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session.compact",
                    detail: "OpenCode session compaction did not complete within 10 minutes.",
                    cause,
                  }),
                ),
            }),
            Effect.asVoid,
          );
        }),
      );
    });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureV2SessionContext(threadId);
        const activeTurnId = context.activeTurnId;
        if (turnId !== undefined && activeTurnId !== turnId) {
          return;
        }
        const target = turnId ?? activeTurnId;
        if (target === undefined) {
          return;
        }
        yield* runOpenCodeSdk("session.interrupt", (signal) =>
          context.client.session.interrupt({ sessionID: context.openCodeSessionId }, { signal }),
        ).pipe(
          Effect.timeout("10 seconds"),
          Effect.catchTags({
            OpenCodeRuntimeError: (cause) => Effect.fail(toRequestError(cause)),
            TimeoutError: (cause) =>
              Effect.fail(
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session.interrupt",
                  detail: "OpenCode session interrupt did not complete within 10 seconds.",
                  cause,
                }),
              ),
          }),
        );
        yield* abortV2Turn(context, target, "Interrupted by user.");
      },
    );

    const respondToRequest: OpenCodeAdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureV2SessionContext(threadId);
      const request = context.pendingPermissions.get(requestId);
      if (!request) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }
      const reply = toOpenCodePermissionReply(decision);
      yield* runOpenCodeSdk("permission.reply", (signal) =>
        context.client.permission.reply(
          { sessionID: context.openCodeSessionId, requestID: requestId, decision: reply },
          { signal },
        ),
      ).pipe(
        Effect.mapError(toRequestError),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "permission.reply",
                detail: "OpenCode permission reply did not complete within 10 seconds.",
              }),
            ),
        }),
      );
      yield* resolveV2PermissionReply(context, requestId, reply, {
        type: "permission.reply",
        requestID: requestId,
        reply,
      });
    });

    const respondToUserInput: OpenCodeAdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureV2SessionContext(threadId);
      const form = context.pendingForms.get(requestId);
      if (!form) {
        if (context.emittedTerminalRequestIds.has(requestId)) return;
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "form.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      const answer = toV2FormAnswer(form, answers);
      yield* runOpenCodeSdk("form.reply", (signal) =>
        context.client.session.form.reply(
          { sessionID: context.openCodeSessionId, formID: requestId, answer },
          { signal },
        ),
      ).pipe(
        Effect.mapError(toRequestError),
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "form.reply",
                detail: "OpenCode question reply did not complete within 10 seconds.",
              }),
            ),
        }),
      );
      yield* resolveV2FormReply(context, requestId, answer, {
        type: "form.reply",
        formID: requestId,
      });
    });

    const stopSession: OpenCodeAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopV2Context(context);
        deleteContextIfCurrent(context);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: { reason: "Session stopped.", recoverable: false, exitKind: "graceful" },
        });
      },
    );

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCodeAdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureV2SessionContext(threadId);
        const messages = yield* runOpenCodeSdk("message.list", (signal) =>
          context.client.message.list({ sessionID: context.openCodeSessionId }, { signal }),
        ).pipe(Effect.mapError(toRequestError));
        const turns: Array<{ readonly id: TurnId; readonly items: Array<unknown> }> = [];
        for (const entry of messages.data ?? []) {
          if (entry.type === "assistant") {
            turns.push({ id: TurnId.make(entry.id), items: [entry] });
          }
        }
        return { threadId, turns };
      },
    );

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureV2SessionContext(threadId);
        const snapshot = yield* readThread(threadId);
        const targetIndex = Math.max(0, snapshot.turns.length - numTurns);
        const target = snapshot.turns[targetIndex];
        if (target) {
          const messages = yield* runOpenCodeSdk("message.list", (signal) =>
            context.client.message.list({ sessionID: context.openCodeSessionId }, { signal }),
          ).pipe(Effect.mapError(toRequestError));
          const entries = messages.data ?? [];
          const targetMessageIndex = entries.findIndex((entry) => entry.id === target.id);
          if (targetMessageIndex < 0) {
            return yield* toRequestError(
              new OpenCodeRuntimeError({
                operation: "session.fork",
                detail: "The OpenCode rewind boundary is no longer available.",
              }),
            );
          }
          const firstRemovedMessage =
            entries.slice(0, targetMessageIndex + 1).findLast((entry) => entry.type === "user") ??
            entries[targetMessageIndex]!;
          const forked = yield* runOpenCodeSdk("session.fork", (signal) =>
            context.client.session.fork(
              { sessionID: context.openCodeSessionId, before: firstRemovedMessage.id },
              { signal },
            ),
          ).pipe(Effect.mapError(toRequestError));
          yield* runOpenCodeSdk("session.update", (signal) =>
            context.client.session.update(
              {
                sessionID: forked.id,
                permissions: buildOpenCodeV2PermissionRules(context.session.runtimeMode),
              },
              { signal },
            ),
          ).pipe(Effect.mapError(toRequestError));
          context.openCodeSessionId = forked.id;
          context.relatedSessionIds.clear();
          context.relatedSessionIds.add(forked.id);
          context.pendingPermissions.clear();
          context.pendingForms.clear();
          context.textBuffers.clear();
          context.reasoningBuffers.clear();
          context.toolsById.clear();
          context.turnUsage = undefined;
          context.hasSubagents = false;
          context.activeTurnId = undefined;
          context.session = {
            ...context.session,
            resumeCursor: {
              schemaVersion: OPENCODE_V2_RESUME_VERSION,
              sessionId: forked.id,
            },
            updatedAt: yield* nowIso,
          };
          yield* emit({
            ...(yield* buildEventBase({ threadId })),
            type: "thread.started",
            payload: { providerThreadId: forked.id },
          });
          const forkedMessages = yield* runOpenCodeSdk("message.list", (signal) =>
            context.client.message.list({ sessionID: forked.id }, { signal }),
          ).pipe(Effect.mapError(toRequestError));
          return {
            threadId,
            turns: (forkedMessages.data ?? [])
              .filter((entry) => entry.type === "assistant")
              .map((entry) => ({ id: TurnId.make(entry.id), items: [entry] })),
          };
        }
        return snapshot;
      },
    );

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (context) => Effect.ignoreCause(stopV2Context(context)), {
          concurrency: "unbounded",
          discard: true,
        });
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      compaction: { type: "native", start: compactThread },
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCodeAdapterShape;
  });
}
