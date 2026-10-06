import {
  ApprovalRequestId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { GmailConnection } from "../../../integrations/GmailConnection.ts";
import * as GmailSendApproval from "../../../integrations/GmailSendApproval.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GmailToolkitHandlersLive } from "./handlers.ts";
import { GmailToolkit } from "./tools.ts";

const threadId = ThreadId.make("mail-task");
const thread: OrchestrationThreadShell = {
  id: threadId,
  projectId: ProjectId.make("space"),
  title: "Email",
  modelSelection: { instanceId: ProviderInstanceId.make("opencode-custom"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

function scenario(
  decision: ProviderApprovalDecision,
  options: {
    disableAfterReview?: boolean;
    capability?: boolean;
    stopAfterReview?: boolean;
    archiveAfterReview?: boolean;
    startDisabled?: boolean;
    enableBeforeCall?: boolean;
    operation?: "send" | "change" | "read";
  } = {},
) {
  return Effect.gen(function* () {
    const approvals = yield* GmailSendApproval.GmailSendApproval;
    const input = { to: ["recipient@example.com"], subject: "HI", body: "Exact message" };
    const commands: OrchestrationCommand[] = [];
    const sent: { message: typeof input; sender: string | undefined }[] = [];
    const change = { messageId: "abc123", action: "archive" as const };
    const changed: { messageId: string; sender: string }[] = [];
    let reads = 0;
    let enabled = !options.startDisabled;
    let threadRow = thread;
    const dependencies = Layer.mergeAll(
      Layer.succeed(GmailSendApproval.GmailSendApproval, approvals),
      Layer.mock(GmailConnection)({
        status: Effect.succeed({ configured: true, connected: true, email: "sender@example.com" }),
        send: (message, sender) =>
          Effect.sync(() => {
            sent.push({ message: { ...message, to: [...message.to] }, sender });
            return { id: "sent-id" };
          }),
        readMessage: () =>
          Effect.sync(() => {
            reads++;
            return {
              id: "abc123",
              threadId: "mail-thread",
              from: "merchant@example.com",
              to: "sender@example.com",
              subject: "Invoice",
              date: "",
              snippet: "Your bill",
              labelIds: ["INBOX"],
              body: "Untrusted mail",
              bodyFormat: "text" as const,
              truncated: false,
              attachments: [],
            };
          }),
        modify: (message, sender) =>
          Effect.sync(() => {
            changed.push({ messageId: message.messageId, sender });
            return { id: message.messageId, labelIds: [] };
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.sync(() => Option.some(threadRow)),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          enableGmailAccess: enabled,
        })),
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            if (
              command.type === "thread.activity.append" &&
              command.activity.kind === "approval.requested"
            ) {
              const payload = command.activity.payload as Record<string, unknown>;
              if (options.operation === "change") {
                expect(String(payload.requestId)).toContain("gmail-change:");
                expect(payload.detail).toBe(
                  "Account: sender@example.com\nMessage ID: abc123\nFrom: merchant@example.com\nSubject: Invoice\nAction: archive\n\nYour bill",
                );
                change.messageId = "hidden-message";
              } else
                expect(payload.detail).toBe(
                  "From: sender@example.com\nTo: recipient@example.com\nSubject: HI\n\nExact message",
                );
              // A changed caller input must not change what was reviewed.
              input.to.push("hidden@example.com");
              input.body = "Changed after review";
              if (options.disableAfterReview) enabled = false;
              if (options.stopAfterReview)
                threadRow = {
                  ...thread,
                  session: {
                    threadId,
                    status: "stopped",
                    providerName: "opencode",
                    runtimeMode: "full-access",
                    activeTurnId: null,
                    lastError: null,
                    updatedAt: "2026-10-04T00:00:00.000Z",
                  },
                };
              if (options.archiveAfterReview) threadRow = { ...threadRow, archivedAt: "2026-10-05T00:00:00.000Z" };
              yield* approvals.respond(
                threadId,
                ApprovalRequestId.make(String(payload.requestId)),
                decision,
              );
            }
            return { sequence: commands.length };
          }),
      }),
      NodeServices.layer,
    );
    const toolkit = yield* GmailToolkit.pipe(
      Effect.provide(GmailToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    // Enabling mid-session with the existing credential must succeed: the
    // capability was issued independently of the toggle and the handler reads
    // the live switch on every call.
    if (options.enableBeforeCall) enabled = true;
    const invocation =
      options.operation === "change"
        ? toolkit.handle("gmail_modify_message", change).pipe(Stream.unwrap, Stream.runDrain)
        : options.operation === "read"
          ? toolkit
              .handle("gmail_read_message", { messageId: "abc123" })
              .pipe(Stream.unwrap, Stream.runDrain)
          : toolkit.handle("gmail_send_email", input).pipe(Stream.unwrap, Stream.runDrain);
    const result = yield* invocation.pipe(
      Effect.result,
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("host"),
        threadId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("opencode-custom"),
        capabilities: new Set<McpInvocationContext.McpCapability>(
          options.capability === false ? [] : ["gmail"],
        ),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
    return { result, commands, sent, changed, reads };
  }).pipe(Effect.provide(GmailSendApproval.layer.pipe(Layer.provide(NodeServices.layer))));
}

describe("Gmail tool email review", () => {
  it.effect("reads without a mailbox change and refuses reads when the capability is absent", () =>
    Effect.gen(function* () {
      const allowed = yield* scenario("accept", { operation: "read" });
      expect(allowed.result._tag).toBe("Success");
      expect(allowed.reads).toBe(1);
      expect(allowed.commands).toHaveLength(0);
      expect(allowed.sent).toHaveLength(0);
      expect(allowed.changed).toHaveLength(0);
      const denied = yield* scenario("accept", { operation: "read", capability: false });
      expect(denied.result._tag).toBe("Failure");
      expect(denied.reads).toBe(0);
    }),
  );
  it.effect("organizes only the exact reviewed message with one-use approval", () =>
    Effect.gen(function* () {
      const allowed = yield* scenario("accept", { operation: "change" });
      expect(allowed.result._tag).toBe("Success");
      expect(allowed.changed).toEqual([{ messageId: "abc123", sender: "sender@example.com" }]);
      for (const decision of ["decline", "acceptForSession"] as const) {
        const denied = yield* scenario(decision, { operation: "change" });
        expect(denied.result._tag).toBe("Failure");
        expect(denied.changed).toHaveLength(0);
      }
      for (const options of [
        { disableAfterReview: true },
        { stopAfterReview: true },
        { archiveAfterReview: true },
        { capability: false },
      ]) {
        const denied = yield* scenario("accept", { operation: "change", ...options });
        expect(denied.result._tag).toBe("Failure");
        expect(denied.changed).toHaveLength(0);
      }
    }),
  );
  it.effect(
    "sends only the reviewed content and sender in a full-access custom provider task",
    () =>
      Effect.gen(function* () {
        const test = yield* scenario("accept");
        expect(test.result._tag).toBe("Success");
        expect(test.sent).toEqual([
          {
            message: { to: ["recipient@example.com"], subject: "HI", body: "Exact message" },
            sender: "sender@example.com",
          },
        ]);
        expect(test.commands).toHaveLength(2);
        expect(test.commands[1]).toMatchObject({ activity: { kind: "approval.resolved" } });
      }),
  );
  it.effect("does not send when the user declines or grants session permission", () =>
    Effect.gen(function* () {
      for (const decision of ["decline", "acceptForSession"] as const) {
        const test = yield* scenario(decision);
        expect(test.result._tag).toBe("Failure");
        expect(test.sent).toHaveLength(0);
        expect(test.commands).toHaveLength(2);
      }
    }),
  );
  it.effect("rechecks the switch after approval and rejects missing tool access", () =>
    Effect.gen(function* () {
      const disabled = yield* scenario("accept", { disableAfterReview: true });
      expect(disabled.result._tag).toBe("Failure");
      expect(disabled.sent).toHaveLength(0);
      const denied = yield* scenario("accept", { capability: false });
      const stopped = yield* scenario("accept", { stopAfterReview: true });
      expect(stopped.result._tag).toBe("Failure");
      expect(stopped.sent).toHaveLength(0);
      const archived = yield* scenario("accept", { archiveAfterReview: true });
      expect(archived.result._tag).toBe("Failure");
      expect(archived.sent).toHaveLength(0);
      expect(denied.result._tag).toBe("Failure");
      expect(denied.sent).toHaveLength(0);
      expect(denied.commands).toHaveLength(0);
    }),
  );
  it.effect("allows a read when the switch starts off and is enabled mid-session", () =>
    Effect.gen(function* () {
      // The credential already carries the capability; only the live switch gates.
      const enabled = yield* scenario(
        "accept",
        { operation: "read", startDisabled: true, enableBeforeCall: true },
      );
      expect(enabled.result._tag).toBe("Success");
      expect(enabled.reads).toBe(1);
      const stillOff = yield* scenario("accept", { operation: "read", startDisabled: true });
      expect(stillOff.result._tag).toBe("Failure");
      expect(stillOff.reads).toBe(0);
    }),
  );
});
