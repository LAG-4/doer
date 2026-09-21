import * as NodeURL from "node:url";

import type { ChatAttachment, ProviderApprovalDecision, RuntimeMode } from "@t3tools/contracts";
import {
  createOpencodeClient,
  type Agent,
  type Command,
  type FilePartInput,
  type Model,
  type OpencodeClient,
  type PermissionRuleset,
  type ProviderListResponse,
  type QuestionAnswer,
  type QuestionRequest,
} from "@opencode-ai/sdk/v2";
import { OpenCode as OpenCodeV2ClientFactory } from "@opencode/client";
import type {
  ModelInfo as OpenCodeV2ModelInfo,
  ProviderInfo as OpenCodeV2ProviderInfo,
} from "@opencode/client";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { compareSemverVersions, parseSemver } from "@t3tools/shared/semver";
import {
  CommandResolutionCache,
  resolveCommandPath,
  resolveSpawnCommand,
} from "@t3tools/shared/shell";
import {
  isDefaultOpenCodeBinary,
  openCodeArchiveExtractCommand,
  openCodeBinaryCandidates,
  openCodeCurlDownloadArgs,
  openCodeExtractedBinaryNames,
  openCodeInstallArchiveFilename,
  openCodeInstallDownloadUrl,
  openCodeInstallTargetForHost,
  openCodeManagedBinaryPath,
  openCodeManagedPackageJson,
  openCodeManagedScriptBinDir,
  openCodeManagedScriptBinaryPath,
  openCodeNpmInstallArgs,
  OPENCODE_NPM_INSTALL_SPEC,
  OPENCODE_NPM_INSTALL_SPEC_V2,
} from "./opencodeInstall.ts";
const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const OPENCODE_EMPTY_CONFIG_CONTENT = "{}";

export const MINIMUM_OPENCODE_VERSION = "1.14.19";
/**
 * Minimum OpenCode 2 version Doer speaks. v2.0.0 is the first stable v2
 * release; the v2 server API (`/api/*`, `@opencode/client`) is fixed from
 * there. Older 2.0.0-dev/beta builds are rejected like old v1 builds.
 */
export const MINIMUM_OPENCODE_V2_VERSION = "2.0.0";

/** Which server API contract a connected OpenCode server speaks. */
export type OpenCodeApiVersion = 1 | 2;

export interface OpenCodeServerVersion {
  readonly version: string;
  readonly apiVersion: OpenCodeApiVersion;
}

/** v2 client handle from `@opencode/client` (OpenCode 2 line). */
export type OpenCodeV2Client = ReturnType<typeof OpenCodeV2ClientFactory.make>;

/** True for versions speaking the v2 API (`/api/*`, `@opencode/client`). */
export function isOpenCodeV2Version(version: string): boolean {
  const parsed = parseSemver(version);
  return parsed !== null && parsed.major >= 2;
}
const OPENCODE_HEALTH_TIMEOUT = "5 seconds";
const OPENCODE_NPM_INSTALL_TIMEOUT_MS = 5 * 60_000;
const OPENCODE_SCRIPT_INSTALL_TIMEOUT_MS = 5 * 60_000;
const OPENCODE_NPM_INSTALL_MAX_OUTPUT_BYTES = 32 * 1024;

const OpenCodeHealthSchema = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
});
const decodeOpenCodeHealth = Schema.decodeUnknownEffect(OpenCodeHealthSchema);

export function resolveOpenCodeConfigContent(
  inputEnvironment: Readonly<Record<string, string | undefined>> | undefined,
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return (
    inputEnvironment?.OPENCODE_CONFIG_CONTENT ??
    inheritedEnvironment.OPENCODE_CONFIG_CONTENT ??
    OPENCODE_EMPTY_CONFIG_CONTENT
  );
}

export function resolveOpenCodeServerPassword(
  input: {
    readonly external: boolean;
    readonly serverPassword?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
  },
  inheritedEnvironment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  if (input.serverPassword !== undefined) {
    return input.serverPassword;
  }
  if (input.external) {
    return undefined;
  }
  return input.environment === undefined
    ? inheritedEnvironment.OPENCODE_SERVER_PASSWORD
    : input.environment.OPENCODE_SERVER_PASSWORD;
}

const OPENCODE_SERVER_READY_PREFIXES = ["opencode server listening", "server listening"];
const OPENCODE_SERVER_PASSWORD_PREFIX = "server password";
const DEFAULT_OPENCODE_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS = 64 * 1024;
const OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export interface OpenCodeServerProcess {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly apiVersion: OpenCodeApiVersion;
  readonly isRunning: Effect.Effect<boolean>;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCodeServerConnection {
  readonly url: string;
  readonly serverPassword?: string;
  readonly version: string;
  readonly apiVersion: OpenCodeApiVersion;
  readonly exitCode: Effect.Effect<number, never> | null;
  readonly external: boolean;
}

const OPENCODE_RUNTIME_ERROR_TAG = "OpenCodeRuntimeError";
export class OpenCodeRuntimeError extends Data.TaggedError(OPENCODE_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCodeRuntimeError =>
    P.isTagged(u, OPENCODE_RUNTIME_ERROR_TAG);
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export function openCodeRuntimeErrorDetail(cause: unknown): string {
  if (OpenCodeRuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // SDK v2 throws { response, request, error? } shapes — extract what's useful
    const anyCause = cause as Record<string, unknown>;
    const status = (anyCause.response as { status?: number } | undefined)?.status;
    const body = anyCause.error ?? anyCause.data ?? anyCause.body;
    const encodedBody = encodeJsonStringForDiagnostics(body ?? cause);
    if (encodedBody) {
      return `status=${status ?? "?"} body=${encodedBody}`;
    }
  }
  return String(cause);
}

const AGENT_NOT_FOUND_PATTERN = /agent not found/i;

/**
 * Whether a failure is the OpenCode server rejecting an unknown agent name
 * (e.g. `Agent not found: "Build"`). Adapters use this to fall back to the
 * server default instead of failing the turn on a stale client selection.
 */
export function isOpenCodeAgentNotFoundError(cause: unknown): boolean {
  return AGENT_NOT_FOUND_PATTERN.test(openCodeRuntimeErrorDetail(cause));
}

export const runOpenCodeSdk = <A>(
  operation: string,
  fn: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, OpenCodeRuntimeError> =>
  Effect.tryPromise({
    try: fn,
    catch: (cause) =>
      new OpenCodeRuntimeError({ operation, detail: openCodeRuntimeErrorDetail(cause), cause }),
  }).pipe(Effect.withSpan(`opencode.${operation}`));

export const verifyOpenCodeServerVersion = Effect.fn("verifyOpenCodeServerVersion")(function* (
  client: OpencodeClient,
) {
  const healthOption = yield* runOpenCodeSdk("global.health", (signal) =>
    client.global.health({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT));
  if (Option.isNone(healthOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }

  const health = yield* decodeOpenCodeHealth(healthOption.value.data).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntimeError({
          operation: "global.health",
          detail: `OpenCode server returned an invalid health response. Doer requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
          cause,
        }),
    ),
  );
  if (parseSemver(health.version) === null) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: `OpenCode server returned an invalid version. Doer requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  if (compareSemverVersions(health.version, MINIMUM_OPENCODE_VERSION) < 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "global.health",
      detail: `OpenCode v${health.version} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.`,
    });
  }
  return health.version;
});

const OpenCodeV2ServerInfoSchema = Schema.Struct({
  version: Schema.String,
});
const decodeOpenCodeV2ServerInfo = Schema.decodeUnknownEffect(OpenCodeV2ServerInfoSchema);

/**
 * Build a v2 API client (`@opencode/client`, OpenCode 2 line). Auth is the
 * same Basic `opencode:<password>` scheme v1 uses; the client takes it as a
 * plain header. Standalone (not on the runtime service) so v1-only mocks and
 * callers are untouched.
 */
export function createOpenCodeV2Client(input: {
  readonly baseUrl: string;
  readonly serverPassword?: string;
  readonly fetch?: typeof globalThis.fetch;
}): OpenCodeV2Client {
  return OpenCodeV2ClientFactory.make({
    baseUrl: input.baseUrl,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.serverPassword
      ? {
          headers: {
            Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
          },
        }
      : {}),
  });
}

/**
 * Walk `cause`/`body`/`error`/`data` for the first numeric HTTP status.
 * Both SDK lines surface transport statuses differently (v1 nests under
 * `response`, v2 under `cause`), so version routing inspects all of them.
 */
function openCodeHttpStatusOf(cause: unknown): number | undefined {
  const seen = new Set<unknown>();
  const queue: Array<unknown> = [cause];
  for (let steps = 0; queue.length > 0 && steps < 16; steps += 1) {
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
    if (statuses.length > 0) {
      return statuses[0];
    }
    for (const key of ["cause", "body", "error", "data"] as const) {
      if (record[key] !== undefined) {
        queue.push(record[key]);
      }
    }
  }
  return undefined;
}

export const verifyOpenCodeServerVersionV2 = Effect.fn("verifyOpenCodeServerVersionV2")(function* (
  client: OpenCodeV2Client,
) {
  const infoOption = yield* runOpenCodeSdk("server.info", (signal) =>
    client.server.info({ signal }),
  ).pipe(Effect.timeoutOption(OPENCODE_HEALTH_TIMEOUT));
  if (Option.isNone(infoOption)) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: "Timed out while checking the OpenCode server version.",
    });
  }
  const info = yield* decodeOpenCodeV2ServerInfo(infoOption.value).pipe(
    Effect.mapError(
      (cause) =>
        new OpenCodeRuntimeError({
          operation: "server.info",
          detail: `OpenCode server returned an invalid info response. Doer requires OpenCode v${MINIMUM_OPENCODE_V2_VERSION} or newer.`,
          cause,
        }),
    ),
  );
  if (parseSemver(info.version) === null) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode server returned an invalid version. Doer requires OpenCode v${MINIMUM_OPENCODE_V2_VERSION} or newer.`,
    });
  }
  if (compareSemverVersions(info.version, MINIMUM_OPENCODE_V2_VERSION) < 0) {
    return yield* new OpenCodeRuntimeError({
      operation: "server.info",
      detail: `OpenCode v${info.version} is too old. Upgrade to v${MINIMUM_OPENCODE_V2_VERSION} or newer.`,
    });
  }
  return info.version;
});

/**
 * Version-check a server of either line: probe the v2 API and the v1 health
 * endpoint concurrently and speak whichever answers. When both fail, the v2
 * error surfaces — unless the server answered the v2 probe with 404 (unknown
 * `/api/*` route means a v1 server), in which case the v1 error is the
 * relevant one. A broken v2 connection is therefore never misreported as a
 * v1 server, and a v1 server is found even when the v2 probe fails oddly
 * (proxies, HTML error pages, content-type quirks).
 */
export const verifyOpenCodeServerVersionRouted = Effect.fn("verifyOpenCodeServerVersionRouted")(
  function* (input: { readonly v1: OpencodeClient; readonly v2: OpenCodeV2Client }) {
    const [v2Exit, v1Exit] = yield* Effect.all(
      [
        Effect.exit(verifyOpenCodeServerVersionV2(input.v2)),
        Effect.exit(verifyOpenCodeServerVersion(input.v1)),
      ],
      { concurrency: "unbounded" },
    );
    if (v2Exit._tag === "Success") {
      return { version: v2Exit.value, apiVersion: 2 as const } satisfies OpenCodeServerVersion;
    }
    if (v1Exit._tag === "Success") {
      return { version: v1Exit.value, apiVersion: 1 as const } satisfies OpenCodeServerVersion;
    }
    const v2Failure = Cause.squash(v2Exit.cause);
    const failure =
      openCodeHttpStatusOf(v2Failure) === 404 ? Cause.squash(v1Exit.cause) : v2Failure;
    return yield* Effect.fail(
      OpenCodeRuntimeError.is(failure)
        ? failure
        : new OpenCodeRuntimeError({
            operation: "server.info",
            detail: openCodeRuntimeErrorDetail(failure),
            cause: failure,
          }),
    );
  },
);

export interface OpenCodeCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface OpenCodeInventory {
  readonly providerList: ProviderListResponse;
  readonly agents: ReadonlyArray<Agent>;
  readonly skills: ReadonlyArray<OpenCodeSkill>;
  readonly commands?: ReadonlyArray<OpenCodeSlashCommand>;
}

export type OpenCodeSlashCommand = Pick<Command, "name" | "description" | "source" | "hints">;

/** Command templates stay in OpenCode, which expands arguments and runs MCP prompts. */
export const loadOpenCodeCommands = (client: OpencodeClient) =>
  runOpenCodeSdk("command.list", (signal) => client.command.list(undefined, { signal })).pipe(
    Effect.map((result): ReadonlyArray<OpenCodeSlashCommand> =>
      (result.data ?? []).map(({ name, description, source, hints }) => ({
        name,
        ...(description === undefined ? {} : { description }),
        ...(source === undefined ? {} : { source }),
        hints,
      })),
    ),
  );

/**
 * Load the provider/model/agent/skill/command inventory from a v2 server and
 * normalize it into the shared {@link OpenCodeInventory} shape so provider
 * status, model flattening, and capability mapping stay version-agnostic:
 * - v2 models are a flat list (`model.list`) grouped here by `providerID`;
 *   only enabled models count as connected, mirroring v1's authenticated set.
 * - v2 variants are an array; they become the `{ id: settings }` map v1 uses
 *   so reasoning selectors keep working.
 * - v2 skills carry `path` (not `location`) and commands carry no
 *   `source`/`hints`; both are adapted to the v1 field names downstream.
 * - A freshly booted v2 server settles each location asynchronously: the
 *   first reads can report empty providers or an unpruned model catalog, so
 *   an empty result is reloaded twice before it is trusted.
 */
export const loadOpenCodeV2Inventory = (
  client: OpenCodeV2Client,
  directory: string,
): Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError> => {
  const attempt = () =>
    Effect.all(
      [
        runOpenCodeSdk("provider.list", (signal) =>
          client.provider.list({ location: { directory } }, { signal }),
        ),
        runOpenCodeSdk("model.list", (signal) =>
          client.model.list({ location: { directory } }, { signal }),
        ),
        runOpenCodeSdk("agent.list", (signal) =>
          client.agent.list({ location: { directory } }, { signal }),
        ),
        runOpenCodeSdk("skill.list", (signal) =>
          client.skill.list({ location: { directory } }, { signal }),
        ),
        runOpenCodeSdk("command.list", (signal) =>
          client.command.list({ location: { directory } }, { signal }),
        ),
      ],
      { concurrency: "unbounded" },
    );
  const isSettled = (
    result: [
      { data?: ReadonlyArray<unknown> },
      { data?: ReadonlyArray<unknown> },
      unknown,
      unknown,
      unknown,
    ],
  ): boolean => (result[0].data?.length ?? 0) > 0 && (result[1].data?.length ?? 0) > 0;
  const loadOnce = () =>
    Effect.gen(function* () {
      let result = yield* attempt();
      for (let retry = 0; retry < 2 && !isSettled(result); retry += 1) {
        yield* Effect.sleep("2 seconds");
        result = yield* attempt();
      }
      const [providers, models, agents, skills, commands] = result;
      return normalizeOpenCodeV2Inventory({ providers, models, agents, skills, commands });
    });
  // A cold v2 server can fail individual reads while locations initialize;
  // retry once after a short pause (mirrors the CLI inventory path) before
  // reporting the provider unavailable.
  return Effect.gen(function* () {
    const first = yield* Effect.exit(loadOnce());
    if (first._tag === "Success") {
      return first.value;
    }
    yield* Effect.sleep("1 second");
    return yield* loadOnce();
  });
};

function normalizeOpenCodeV2Inventory(input: {
  readonly providers: { readonly data?: ReadonlyArray<OpenCodeV2ProviderInfo> };
  readonly models: { readonly data?: ReadonlyArray<OpenCodeV2ModelInfo> };
  readonly agents: {
    readonly data?: ReadonlyArray<{ name: string; mode: Agent["mode"]; hidden?: boolean }>;
  };
  readonly skills: {
    readonly data?: ReadonlyArray<{ name: string; description?: string; path: string }>;
  };
  readonly commands: { readonly data?: ReadonlyArray<{ name: string; description?: string }> };
}): OpenCodeInventory {
  const { providers, models, agents, skills, commands } = input;
  const providerById = new Map<
    string,
    { id: string; name: string; models: Record<string, Model> }
  >();
  const ensureProvider = (info: Pick<OpenCodeV2ProviderInfo, "id" | "name">) => {
    let provider = providerById.get(info.id);
    if (!provider) {
      provider = { id: info.id, name: info.name, models: {} };
      providerById.set(info.id, provider);
    }
    return provider;
  };
  for (const info of providers.data ?? []) {
    ensureProvider(info);
  }
  const toV1Variants = (variants: OpenCodeV2ModelInfo["variants"]): Model["variants"] => {
    const mapped: Record<string, { [key: string]: unknown }> = {};
    for (const variant of variants ?? []) {
      mapped[variant.id] = { ...variant.settings };
    }
    return mapped;
  };
  for (const model of models.data ?? []) {
    if (model.enabled === false) {
      continue;
    }
    const provider = ensureProvider({ id: model.providerID, name: model.providerID });
    provider.models[model.modelID] = {
      id: model.modelID,
      providerID: model.providerID,
      name: model.name,
      variants: toV1Variants(model.variants),
    } as unknown as Model;
  }
  const connected = [...providerById.values()]
    .filter((provider) => Object.keys(provider.models).length > 0)
    .map((provider) => provider.id);
  return {
    providerList: {
      all: [...providerById.values()].map((provider) => ({
        id: provider.id,
        name: provider.name,
        source: "api" as const,
        env: [],
        options: {},
        models: provider.models,
      })),
      default: {},
      connected,
    },
    agents: (agents.data ?? []).map((agent): Agent => ({
      name: agent.name,
      mode: agent.mode,
      ...(agent.hidden !== undefined ? { hidden: agent.hidden } : {}),
      permission: [],
      options: {},
    })),
    skills: (skills.data ?? []).map((skill) => ({
      name: skill.name,
      ...(skill.description === undefined ? {} : { description: skill.description }),
      location: skill.path,
    })),
    commands: (commands.data ?? []).map((command): OpenCodeSlashCommand => ({
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      hints: [],
    })),
  } satisfies OpenCodeInventory;
}

export interface OpenCodeV2PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

/**
 * v2 permission ruleset (`{ action, resource, effect }`) mirroring
 * {@link buildOpenCodePermissionRules}. Action renames follow the v2
 * contract: `bash` → `shell`. `lsp` and `doom_loop` are not v2 Core actions
 * and are dropped; unmatched tools still default to `ask` server-side.
 */
export function buildOpenCodeV2PermissionRules(
  runtimeMode: RuntimeMode,
): Array<OpenCodeV2PermissionRule> {
  if (runtimeMode === "full-access") {
    return [
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "allow" },
    ];
  }
  const editEffect = runtimeMode === "auto-accept-edits" ? "allow" : "ask";
  return [
    { action: "*", resource: "*", effect: "ask" },
    { action: "read", resource: "*", effect: "allow" },
    { action: "read", resource: "*.env", effect: "ask" },
    { action: "read", resource: "*.env.*", effect: "ask" },
    { action: "read", resource: "*.env.example", effect: "allow" },
    { action: "glob", resource: "*", effect: "allow" },
    { action: "grep", resource: "*", effect: "allow" },
    { action: "skill", resource: "*", effect: "allow" },
    { action: "todowrite", resource: "*", effect: "allow" },
    { action: "shell", resource: "*", effect: "ask" },
    { action: "edit", resource: "*", effect: editEffect },
    { action: "webfetch", resource: "*", effect: "ask" },
    { action: "websearch", resource: "*", effect: "ask" },
    { action: "codesearch", resource: "*", effect: "ask" },
    { action: "external_directory", resource: "*", effect: "ask" },
    { action: "question", resource: "*", effect: "allow" },
  ];
}

export interface OpenCodeV2FilePart {
  readonly uri: string;
  readonly name?: string;
}

/**
 * v2 prompt attachments (`{ uri, name }` — v2 carries no MIME type).
 * Same native-part filtering as {@link toOpenCodeFileParts}.
 */
export function toOpenCodeV2FileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<OpenCodeV2FilePart> {
  return toOpenCodeFileParts(input).map((part) => ({
    uri: part.url,
    ...(part.filename !== undefined ? { name: part.filename } : {}),
  }));
}

export interface ParsedOpenCodeModelSlug {
  readonly providerID: string;
  readonly modelID: string;
}

export interface OpenCodeSkill {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly location?: string | null;
}

/**
 * Result of making sure an OpenCode CLI is available. `binaryPath` is the
 * resolved executable to use (absolute when it came from a well-known
 * location); `freshInstall` reports whether this call installed it.
 */
export interface EnsureOpenCodeInstallResult {
  readonly binaryPath: string;
  readonly freshInstall: boolean;
}

const OpenCodeSkillSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  location: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeOpenCodeSkillsCliOutputExit = Schema.decodeUnknownExit(
  Schema.fromJsonString(Schema.Array(OpenCodeSkillSchema)),
);

export interface OpenCodeRuntimeShape {
  /**
   * Spawns a local OpenCode server process. Its lifetime is bound to the caller's
   * `Scope.Scope` — the child is killed automatically when that scope closes.
   * Consumers that want a long-lived server must create and hold a scope explicitly
   * (see {@link Scope.make}) and close it when done.
   */
  readonly startOpenCodeServerProcess: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    /** T3-managed `<baseDir>/tools/opencode` dir; enables the install fallback. */
    readonly managedDir?: string;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerProcess, OpenCodeRuntimeError, Scope.Scope>;
  /**
   * Returns a handle to either an externally-managed OpenCode server (when
   * `serverUrl` is provided — no lifetime is attached to the caller's scope) or a
   * freshly spawned local server whose lifetime is bound to the caller's scope.
   */
  readonly connectToOpenCodeServer: (input: {
    readonly binaryPath: string;
    readonly directory: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string;
    readonly environment?: NodeJS.ProcessEnv;
    /** T3-managed `<baseDir>/tools/opencode` dir; enables the install fallback. */
    readonly managedDir?: string;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCodeServerConnection, OpenCodeRuntimeError, Scope.Scope>;
  readonly runOpenCodeCommand: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    /** T3-managed `<baseDir>/tools/opencode` dir; enables the install fallback. */
    readonly managedDir?: string;
    readonly cwd?: string;
    readonly maxOutputBytes?: number;
  }) => Effect.Effect<OpenCodeCommandResult, OpenCodeRuntimeError>;
  readonly createOpenCodeSdkClient: (input: {
    readonly baseUrl: string;
    readonly directory: string;
    readonly serverPassword?: string;
  }) => OpencodeClient;
  readonly loadOpenCodeInventory: (
    client: OpencodeClient,
  ) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadOpenCodeSkills: (
    client: OpencodeClient,
  ) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
  readonly loadInventoryFromCli: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    /** T3-managed `<baseDir>/tools/opencode` dir; enables the install fallback. */
    readonly managedDir?: string;
  }) => Effect.Effect<OpenCodeInventory, OpenCodeRuntimeError>;
  readonly loadSkillsFromCli: (input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly environment?: NodeJS.ProcessEnv;
    /** T3-managed `<baseDir>/tools/opencode` dir; enables the install fallback. */
    readonly managedDir?: string;
  }) => Effect.Effect<ReadonlyArray<OpenCodeSkill>, OpenCodeRuntimeError>;
  /**
   * Makes sure an OpenCode CLI exists, installing it into `managedDir` (npm
   * first, official release download with curl when npm is missing) when no
   * usable binary is found. Custom (non-default) `binaryPath` values are
   * only verified, never installed. Serialized across callers so concurrent
   * probes cannot run overlapping installs.
   */
  readonly ensureOpenCodeInstalled: (input: {
    readonly binaryPath: string;
    readonly managedDir?: string;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<EnsureOpenCodeInstallResult, OpenCodeRuntimeError>;
}

/** @internal */
export function parseServerUrlFromOutput(output: string): string | null {
  for (const line of output.split("\n")) {
    // v1 prints `opencode server listening on <url>`; v2 prints
    // `server listening on <url>`. Accept either.
    if (!OPENCODE_SERVER_READY_PREFIXES.some((prefix) => line.startsWith(prefix))) {
      continue;
    }
    const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
    return match?.[1] ?? null;
  }
  return null;
}

/**
 * v2 prints an auto-generated password (`server password <pwd>`) when no
 * `OPENCODE_SERVER_PASSWORD` was provided. Capture it so the client can
 * authenticate; v1 never prints this line. Returns the last match so a
 * restarted server's newest password wins.
 *
 * @internal
 */
export function parseServerPasswordFromOutput(output: string): string | null {
  let password: string | null = null;
  for (const line of output.split("\n")) {
    if (!line.startsWith(OPENCODE_SERVER_PASSWORD_PREFIX)) {
      continue;
    }
    const candidate = line.slice(OPENCODE_SERVER_PASSWORD_PREFIX.length).trim();
    if (candidate.length > 0) {
      password = candidate;
    }
  }
  return password;
}

const SLUG_LINE_RE = /^(\S+\/\S+)\s*$/;
const AGENT_HEADER_RE = /^(.+)\s+\((\S+)\)\s*$/;

// Agents that are always hidden in OpenCode but the CLI "agent list" command
// does not expose the hidden flag. Keep in sync with OpenCode agent
// definitions (in the OpenCode repo: packages/opencode/src/agent/agent.ts).
const KNOWN_HIDDEN_AGENTS = new Set(["compaction", "summary", "title"]);

/** @internal */
export function parseModelsCliOutput(stdout: string): {
  readonly providers: ReadonlyMap<
    string,
    { readonly id: string; readonly name: string; readonly models: { [key: string]: Model } }
  >;
  readonly connected: ReadonlyArray<string>;
} {
  const providers = new Map<
    string,
    { id: string; name: string; models: { [key: string]: Model } }
  >();
  const lines = stdout.split("\n");
  let currentSlug: string | null = null;
  const jsonLines: Array<string> = [];

  const flushModel = () => {
    if (currentSlug !== null && jsonLines.length > 0) {
      const jsonStr = jsonLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const model = JSON.parse(jsonStr) as Model;
          const separator = currentSlug.indexOf("/");
          if (separator > 0) {
            const providerID = currentSlug.slice(0, separator);
            const modelID = currentSlug.slice(separator + 1);
            let provider = providers.get(providerID);
            if (!provider) {
              provider = { id: providerID, name: providerID, models: {} };
              providers.set(providerID, provider);
            }
            provider.models[modelID] = model;
          }
        } catch {
          // Skip unparseable model JSON
        }
      }
    }
    currentSlug = null;
    jsonLines.length = 0;
  };

  for (const line of lines) {
    // A model's JSON body is a single `JSON.stringify` line starting with `{`,
    // while a provider/model slug is a bare `provider/model` header. Only the
    // latter can be a slug: without this guard a body line with no interior
    // whitespace and a `/` in one of its values (e.g. an OpenRouter model whose
    // `id` is `vendor/model`) matches SLUG_LINE_RE, so flushModel runs against
    // an empty body and the model is silently dropped.
    const slugMatch = line.trimStart().startsWith("{") ? null : SLUG_LINE_RE.exec(line);
    if (slugMatch) {
      flushModel();
      currentSlug = slugMatch[1]!;
    } else if (currentSlug !== null) {
      jsonLines.push(line);
    }
  }
  flushModel();

  return { providers, connected: [...providers.keys()] };
}

/** @internal */
export function parseAgentListCliOutput(stdout: string): ReadonlyArray<Agent> {
  const agents: Array<Agent> = [];
  const lines = stdout.split("\n");
  let currentHeader: { name: string; mode: string } | null = null;
  const blockLines: Array<string> = [];

  const flushAgent = () => {
    if (currentHeader !== null) {
      const jsonStr = blockLines.join("\n").trim();
      if (jsonStr.length > 0) {
        try {
          const permission = JSON.parse(jsonStr);
          agents.push({
            name: currentHeader.name,
            mode: currentHeader.mode as Agent["mode"],
            hidden: KNOWN_HIDDEN_AGENTS.has(currentHeader.name),
            permission,
            options: {},
          });
        } catch {
          // Skip unparseable agent
        }
      }
    }
    currentHeader = null;
    blockLines.length = 0;
  };

  for (const line of lines) {
    const match = AGENT_HEADER_RE.exec(line);
    if (match) {
      flushAgent();
      currentHeader = { name: match[1]!, mode: match[2]! };
    } else if (currentHeader !== null) {
      blockLines.push(line);
    }
  }
  flushAgent();

  return agents;
}

/** @internal */
export function parseSkillsCliOutput(stdout: string): ReadonlyArray<OpenCodeSkill> {
  const result = decodeOpenCodeSkillsCliOutputExit(stdout);
  return Exit.isSuccess(result) ? result.value : [];
}

export function parseOpenCodeModelSlug(
  slug: string | null | undefined,
): ParsedOpenCodeModelSlug | null {
  if (typeof slug !== "string") {
    return null;
  }

  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function openCodeQuestionId(
  index: number,
  question: QuestionRequest["questions"][number],
): string {
  const header = question.header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-");
  return header.length > 0 ? `question-${index}-${header}` : `question-${index}`;
}

/**
 * Attachments OpenCode can hand to a model as a native file part. Anything
 * else (ZIP, binaries, image formats like BMP/AVIF/SVG that model APIs
 * reject, or files over the direct-attachment size limit) would make the turn
 * fail before it starts, so those ride only as the file path ProviderService
 * puts in the prompt.
 */
const OPENCODE_NATIVE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const OPENCODE_NATIVE_FILE_PART_MAX_BYTES = 20 * 1024 * 1024;

function isOpenCodeNativeFilePart(input: {
  readonly mimeType: string;
  readonly sizeBytes: number;
}): boolean {
  if (input.sizeBytes > OPENCODE_NATIVE_FILE_PART_MAX_BYTES) {
    return false;
  }
  const normalized = input.mimeType.trim().toLowerCase();
  return (
    OPENCODE_NATIVE_IMAGE_MIMES.has(normalized) ||
    normalized.startsWith("text/") ||
    normalized === "application/pdf"
  );
}

export function toOpenCodeFileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): Array<FilePartInput> {
  const parts: Array<FilePartInput> = [];

  for (const attachment of input.attachments ?? []) {
    if (
      attachment.type === "file" &&
      "source" in attachment &&
      attachment.source?._tag === "pasted-text"
    ) {
      continue;
    }
    if (!isOpenCodeNativeFilePart(attachment)) {
      continue;
    }
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }

    parts.push({
      type: "file",
      mime: attachment.mimeType,
      filename: attachment.name,
      url: NodeURL.pathToFileURL(attachmentPath).href,
    });
  }

  return parts;
}

export function buildOpenCodePermissionRules(runtimeMode: RuntimeMode): PermissionRuleset {
  if (runtimeMode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "external_directory", pattern: "*", action: "allow" },
    ];
  }

  // "Auto-accept edits" is documented as "auto-approve edits, ask before other
  // actions", so prompting for every edit ignores the mode the user picked.
  // "auto" is left asking on purpose: the docs say providers without an AI
  // reviewer, OpenCode among them, fall back to Supervised for that mode.
  const editAction = runtimeMode === "auto-accept-edits" ? "allow" : "ask";

  // Session rules override OpenCode's agent defaults. Allow reads and task
  // updates, but keep its default approval rules for environment files.
  return [
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "read", pattern: "*", action: "allow" },
    { permission: "read", pattern: "*.env", action: "ask" },
    { permission: "read", pattern: "*.env.*", action: "ask" },
    { permission: "read", pattern: "*.env.example", action: "allow" },
    { permission: "glob", pattern: "*", action: "allow" },
    { permission: "grep", pattern: "*", action: "allow" },
    { permission: "lsp", pattern: "*", action: "allow" },
    { permission: "skill", pattern: "*", action: "allow" },
    { permission: "todowrite", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "*", action: "ask" },
    { permission: "edit", pattern: "*", action: editAction },
    { permission: "webfetch", pattern: "*", action: "ask" },
    { permission: "websearch", pattern: "*", action: "ask" },
    { permission: "codesearch", pattern: "*", action: "ask" },
    { permission: "external_directory", pattern: "*", action: "ask" },
    { permission: "doom_loop", pattern: "*", action: "ask" },
    { permission: "question", pattern: "*", action: "allow" },
  ];
}

export function toOpenCodePermissionReply(
  decision: ProviderApprovalDecision,
): "once" | "always" | "reject" {
  switch (decision) {
    case "accept":
      return "once";
    case "acceptForSession":
    case "acceptAlways":
      return "always";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export function toOpenCodeQuestionAnswers(
  request: QuestionRequest,
  answers: Record<string, unknown>,
): Array<QuestionAnswer> {
  return request.questions.map((question, index) => {
    const raw =
      answers[openCodeQuestionId(index, question)] ??
      answers[question.header] ??
      answers[question.question];
    if (Array.isArray(raw)) {
      return raw.filter((value): value is string => typeof value === "string");
    }
    if (typeof raw === "string") {
      return raw.trim().length > 0 ? [raw] : [];
    }
    return [];
  });
}

function ensureRuntimeError(
  operation: OpenCodeRuntimeError["operation"],
  detail: string,
  cause: unknown,
): OpenCodeRuntimeError {
  return OpenCodeRuntimeError.is(cause)
    ? cause
    : new OpenCodeRuntimeError({ operation, detail, cause });
}

const makeOpenCodeRuntime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  // Serializes automatic installs: every probe/adapter instance shares this
  // runtime, so overlapping refreshes queue on one install instead of
  // racing in the same managed directory.
  const installLock = yield* Semaphore.make(1);

  // Fresh (uncached) existence check: the shared resolution cache keeps
  // negative results for 30s, which would hide a binary that appeared since
  // (e.g. right after an automatic install finished).
  const resolveExisting = (candidate: string, env?: NodeJS.ProcessEnv) =>
    resolveCommandPath(candidate, env ? { env } : {}).pipe(
      Effect.provideService(CommandResolutionCache, new Map()),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, pathService),
      Effect.option,
    );

  const firstExisting = (
    candidates: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
  ): Effect.Effect<string | null> =>
    Effect.gen(function* () {
      for (const candidate of candidates) {
        if (Option.isSome(yield* resolveExisting(candidate, env))) {
          return candidate;
        }
      }
      return null;
    });

  const resolveCommand = (
    command: string,
    args: ReadonlyArray<string>,
    env?: NodeJS.ProcessEnv,
    managedDir?: string,
  ) =>
    Effect.gen(function* () {
      const commandOptions = env ? { env } : {};
      // A custom binary path is the user's explicit choice: use it verbatim.
      // The default goes through PATH first, then the official install
      // script's `~/.opencode/bin`, then the T3-managed install — so binaries
      // GUI-launched servers cannot see on PATH are still found.
      if (isDefaultOpenCodeBinary(command)) {
        const candidates = openCodeBinaryCandidates({
          binaryPath: command,
          ...(env !== undefined ? { environment: env } : {}),
          ...(managedDir !== undefined ? { managedDir } : {}),
          platform: hostPlatform,
        });
        const existing = yield* firstExisting(candidates, env);
        if (existing !== null) {
          return yield* resolveSpawnCommand(existing, args, commandOptions);
        }
      }
      return yield* resolveSpawnCommand(command, args, commandOptions);
    });

  const runOpenCodeCommand: OpenCodeRuntimeShape["runOpenCodeCommand"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(
        input.binaryPath,
        input.args,
        input.environment,
        input.managedDir,
      );
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          detached: hostPlatform !== "win32",
          shell: spawnCommand.shell,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const terminateCommandGroup =
        hostPlatform === "win32"
          ? child.kill({ killSignal: "SIGKILL" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), "SIGKILL");
              } catch {
                // The command and its process group may already have exited.
              }
            });
      yield* Effect.addFinalizer(() => terminateCommandGroup.pipe(Effect.ignore));
      const collectOptions =
        input.maxOutputBytes === undefined ? undefined : { maxBytes: input.maxOutputBytes };
      const [stdout, stderr, code] = yield* Effect.all(
        [
          collectStreamAsString(child.stdout, collectOptions),
          collectStreamAsString(child.stderr, collectOptions),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCodeRuntimeError({
          operation: "runOpenCodeCommand",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return {
        stdout,
        stderr,
        code: exitCode,
      } satisfies OpenCodeCommandResult;
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "runOpenCodeCommand",
          `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  const createOpenCodeSdkClient: OpenCodeRuntimeShape["createOpenCodeSdkClient"] = (input) =>
    createOpencodeClient({
      baseUrl: input.baseUrl,
      directory: input.directory,
      ...(input.serverPassword
        ? {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`, "utf8").toString("base64")}`,
            },
          }
        : {}),
      throwOnError: true,
    });

  const startOpenCodeServerProcess: OpenCodeRuntimeShape["startOpenCodeServerProcess"] = (input) =>
    Effect.gen(function* () {
      // Bind this server's lifetime to the caller's scope. When the caller's
      // scope closes, the spawned child is killed and all associated fibers
      // are interrupted automatically — no `close()` method needed.
      const runtimeScope = yield* Scope.Scope;

      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to find available port: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(
        input.binaryPath,
        args,
        input.environment,
        input.managedDir,
      );
      const serverPassword = resolveOpenCodeServerPassword({
        external: false,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
      });

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: {
              ...input.environment,
              ...(serverPassword !== undefined ? { OPENCODE_SERVER_PASSWORD: serverPassword } : {}),
              // Respect an OPENCODE_CONFIG_CONTENT provided by the caller or
              // the inherited process environment, only falling back to the
              // empty config when neither is set. Setting it unconditionally
              // previously clobbered the user's opencode config, hiding their
              // providers/models. The value is set explicitly (rather than
              // relying on inheritance) because `extendEnv` is false whenever
              // `input.environment` is provided.
              OPENCODE_CONFIG_CONTENT: resolveOpenCodeConfigContent(input.environment),
            },
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: `Failed to spawn OpenCode server process: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCodeProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // The direct child may already have exited after starting the
                // server; the process group kill is best-effort cleanup for
                // any serve process left in that group.
              }
            });
      const terminateChild = killOpenCodeProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCodeProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make<string | null>("");
      const stderrRef = yield* Ref.make<string | null>("");
      const readyDeferred = yield* Deferred.make<string, OpenCodeRuntimeError>();

      const setReadyFromStdoutChunk = (chunk: string) =>
        Ref.modify(stdoutRef, (stdout) => {
          if (stdout === null) {
            return [null, null] as const;
          }
          const nextStdout = `${stdout}${chunk}`;
          return [
            parseServerUrlFromOutput(nextStdout),
            nextStdout.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ] as const;
        }).pipe(
          Effect.flatMap((parsed) =>
            parsed ? Deferred.succeed(readyDeferred, parsed).pipe(Effect.ignore) : Effect.void,
          ),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(setReadyFromStdoutChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Ref.update(stderrRef, (stderr) =>
            stderr === null
              ? null
              : `${stderr}${chunk}`.slice(-OPENCODE_SERVER_STARTUP_MAX_OUTPUT_CHARS),
          ),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = (yield* Ref.get(stdoutRef)) ?? "";
            const stderr = (yield* Ref.get(stderrRef)) ?? "";
            const exitCode = Number(code);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCodeRuntimeError({
                operation: "startOpenCodeServerProcess",
                detail: [
                  `OpenCode server exited before startup completed (code: ${String(exitCode)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
                cause: { exitCode, stdout, stderr },
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );

      if (Exit.isFailure(readyExit) || Option.isNone(readyExit.value)) {
        yield* Fiber.interruptAll([stdoutFiber, stderrFiber, exitFiber]).pipe(Effect.ignore);
      }

      if (Exit.isFailure(readyExit)) {
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureRuntimeError(
          "startOpenCodeServerProcess",
          `Failed while waiting for OpenCode server startup: ${openCodeRuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        return yield* new OpenCodeRuntimeError({
          operation: "startOpenCodeServerProcess",
          detail: `Timed out waiting for OpenCode server start after ${timeoutMs}ms.`,
        });
      }

      // Keep draining both pipes until the process scope closes. Stopping the
      // readers can block OpenCode when its output buffers fill. Startup output
      // is no longer needed, so discard later output instead of retaining it.
      const startupOutput = (yield* Ref.get(stdoutRef)) ?? "";
      yield* Ref.set(stdoutRef, null);
      yield* Ref.set(stderrRef, null);

      const url = readyOption.value;
      // v2 prints an auto-generated password when none was configured — adopt
      // it so the client authenticates. An explicitly configured password
      // always wins; v1 never prints one.
      const effectivePassword =
        serverPassword ?? parseServerPasswordFromOutput(startupOutput) ?? undefined;
      const verified = yield* verifyOpenCodeServerVersionRouted({
        v1: createOpenCodeSdkClient({
          baseUrl: url,
          directory: input.directory,
          ...(effectivePassword !== undefined ? { serverPassword: effectivePassword } : {}),
        }),
        v2: createOpenCodeV2Client({
          baseUrl: url,
          ...(effectivePassword !== undefined ? { serverPassword: effectivePassword } : {}),
        }),
      });

      return {
        url,
        ...(effectivePassword !== undefined ? { serverPassword: effectivePassword } : {}),
        version: verified.version,
        apiVersion: verified.apiVersion,
        isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      } satisfies OpenCodeServerProcess;
    });

  const connectToOpenCodeServer: OpenCodeRuntimeShape["connectToOpenCodeServer"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const serverPassword = resolveOpenCodeServerPassword({
        external: true,
        ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      });
      return verifyOpenCodeServerVersionRouted({
        v1: createOpenCodeSdkClient({
          baseUrl: serverUrl,
          directory: input.directory,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
        v2: createOpenCodeV2Client({
          baseUrl: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
        }),
      }).pipe(
        Effect.map((verified) => ({
          url: serverUrl,
          ...(serverPassword !== undefined ? { serverPassword } : {}),
          version: verified.version,
          apiVersion: verified.apiVersion,
          exitCode: null,
          external: true,
        })),
      );
    }

    return startOpenCodeServerProcess({
      binaryPath: input.binaryPath,
      directory: input.directory,
      ...(input.serverPassword !== undefined ? { serverPassword: input.serverPassword } : {}),
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.managedDir !== undefined ? { managedDir: input.managedDir } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        ...(server.serverPassword !== undefined ? { serverPassword: server.serverPassword } : {}),
        version: server.version,
        apiVersion: server.apiVersion,
        exitCode: server.exitCode,
        external: false,
      })),
    );
  };

  const loadProviders = (client: OpencodeClient) =>
    runOpenCodeSdk("provider.list", (signal) => client.provider.list(undefined, { signal })).pipe(
      Effect.filterMapOrFail(
        (list) =>
          list.data
            ? Result.succeed(list.data)
            : Result.fail(
                new OpenCodeRuntimeError({
                  operation: "provider.list",
                  detail: "OpenCode provider list was empty.",
                }),
              ),
        (result) => result,
      ),
    );

  const loadAgents = (client: OpencodeClient) =>
    runOpenCodeSdk("app.agents", (signal) => client.app.agents(undefined, { signal })).pipe(
      Effect.map((result) => result.data ?? []),
      Effect.orElseSucceed((): ReadonlyArray<Agent> => []),
    );

  const loadOpenCodeSkills: OpenCodeRuntimeShape["loadOpenCodeSkills"] = (client) =>
    runOpenCodeSdk("app.skills", (signal) => client.app.skills(undefined, { signal })).pipe(
      Effect.map((result) =>
        (result.data ?? []).map((skill) => ({
          name: skill.name,
          ...(skill.description === undefined ? {} : { description: skill.description }),
          location: skill.location,
        })),
      ),
    );
  const loadSkills = (client: OpencodeClient) =>
    loadOpenCodeSkills(client).pipe(Effect.orElseSucceed((): ReadonlyArray<OpenCodeSkill> => []));

  const loadOpenCodeInventory: OpenCodeRuntimeShape["loadOpenCodeInventory"] = (client) =>
    Effect.all(
      [
        loadProviders(client),
        loadAgents(client),
        loadSkills(client),
        loadOpenCodeCommands(client).pipe(Effect.orElseSucceed(() => [])),
      ],
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.map(([providerList, agents, skills, commands]) => ({
        providerList,
        agents,
        skills,
        commands,
      })),
    );

  const loadInventoryFromCli: OpenCodeRuntimeShape["loadInventoryFromCli"] = (input) =>
    Effect.gen(function* () {
      const env = input.environment !== undefined ? { environment: input.environment } : ({} as {});
      const managed =
        input.managedDir !== undefined ? { managedDir: input.managedDir } : ({} as {});
      const commandContext = { cwd: input.cwd, ...env, ...managed };

      const runModelsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["models", "--verbose"],
          ...commandContext,
        }).pipe(Effect.exit);
      const runAgentsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["agent", "list"],
          ...commandContext,
        }).pipe(Effect.exit);
      const runSkillsCli = () =>
        runOpenCodeCommand({
          binaryPath: input.binaryPath,
          args: ["debug", "skill"],
          maxOutputBytes: OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES,
          ...commandContext,
        }).pipe(Effect.exit);

      // Every OpenCode CLI command opens the same shared SQLite database. Running them
      // concurrently causes "database is locked" failures, so run them one at a time.
      const [initialModelsResult, initialAgentsResult, initialSkillsResult] = yield* Effect.all(
        [runModelsCli(), runAgentsCli(), runSkillsCli()],
        { concurrency: 1 },
      );
      let modelsResult = initialModelsResult;
      let agentsResult = initialAgentsResult;
      let skillsResult = initialSkillsResult;

      // Retry once after 1s on transient failures (e.g. SQLite "database is locked")
      const needsModelsRetry = modelsResult._tag === "Failure" || modelsResult.value.code !== 0;
      const needsAgentsRetry = agentsResult._tag === "Failure" || agentsResult.value.code !== 0;
      const needsSkillsRetry = skillsResult._tag === "Failure" || skillsResult.value.code !== 0;
      if (needsModelsRetry || needsAgentsRetry || needsSkillsRetry) {
        yield* Effect.sleep("1 second");
        const [m2, a2, s2] = yield* Effect.all(
          [
            needsModelsRetry ? runModelsCli() : Effect.succeed(modelsResult),
            needsAgentsRetry ? runAgentsCli() : Effect.succeed(agentsResult),
            needsSkillsRetry ? runSkillsCli() : Effect.succeed(skillsResult),
          ],
          { concurrency: 1 },
        );
        modelsResult = m2;
        agentsResult = a2;
        skillsResult = s2;
      }

      if (modelsResult._tag === "Failure") {
        const cause = Cause.squash(modelsResult.cause);
        return yield* ensureRuntimeError(
          "loadInventoryFromCli",
          `Failed to load OpenCode models: ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        );
      }
      if (modelsResult.value.code !== 0) {
        return yield* new OpenCodeRuntimeError({
          operation: "loadInventoryFromCli",
          detail: `OpenCode models command exited with code ${modelsResult.value.code}.`,
        });
      }

      const parsed = parseModelsCliOutput(modelsResult.value.stdout);
      const connected = [...parsed.connected];
      const allProviders: ProviderListResponse["all"] = [...parsed.providers.values()].map(
        (provider) => ({
          id: provider.id,
          name: provider.name,
          source: "config" as const,
          env: [],
          options: {},
          models: provider.models,
        }),
      );

      // Agent and skill metadata enrich the provider snapshot but are not required
      // for an authoritative model inventory, so either may degrade to an empty list.
      let agents: ReadonlyArray<Agent> = [];
      if (agentsResult._tag === "Success" && agentsResult.value.code === 0) {
        agents = parseAgentListCliOutput(agentsResult.value.stdout);
      }
      let skills: ReadonlyArray<OpenCodeSkill> = [];
      if (skillsResult._tag === "Success" && skillsResult.value.code === 0) {
        skills = parseSkillsCliOutput(skillsResult.value.stdout);
      }

      return {
        providerList: { all: allProviders, default: {}, connected },
        agents,
        skills,
      };
    });

  const loadSkillsFromCli: OpenCodeRuntimeShape["loadSkillsFromCli"] = (input) =>
    runOpenCodeCommand({
      binaryPath: input.binaryPath,
      args: ["debug", "skill"],
      cwd: input.cwd,
      maxOutputBytes: OPENCODE_SKILL_DISCOVERY_MAX_OUTPUT_BYTES,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.managedDir !== undefined ? { managedDir: input.managedDir } : {}),
    }).pipe(
      Effect.flatMap((result) =>
        result.code === 0
          ? Effect.succeed(parseSkillsCliOutput(result.stdout))
          : Effect.fail(
              new OpenCodeRuntimeError({
                operation: "loadSkillsFromCli",
                detail: `OpenCode skills command exited with code ${result.code}.`,
              }),
            ),
      ),
    );

  /**
   * Run one installer child process to completion: spawn, collect capped
   * output, enforce a timeout, and always kill the child on the way out.
   * Shared by the npm and the script-download install paths.
   */
  const runInstallCommand = (input: {
    readonly label: string;
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
  }): Effect.Effect<
    { readonly stdout: string; readonly stderr: string; readonly code: number },
    OpenCodeRuntimeError
  > =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveSpawnCommand(
        input.command,
        input.args,
        input.environment ? { env: input.environment } : {},
      );
      const collected = yield* Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner
            .spawn(
              ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                shell: spawnCommand.shell,
                // Installers need their usual host environment (HOME, cache
                // dirs); the instance environment only overlays (e.g. proxies).
                ...(input.environment ? { env: input.environment, extendEnv: true } : {}),
              }),
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OpenCodeRuntimeError({
                    operation: "ensureOpenCodeInstalled",
                    detail: `Failed to start ${input.label} for the automatic OpenCode install: ${openCodeRuntimeErrorDetail(cause)}`,
                    cause,
                  }),
              ),
            );
          yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
          const [stdout, stderr, code] = yield* Effect.all(
            [
              collectStreamAsString(child.stdout, {
                maxBytes: OPENCODE_NPM_INSTALL_MAX_OUTPUT_BYTES,
              }),
              collectStreamAsString(child.stderr, {
                maxBytes: OPENCODE_NPM_INSTALL_MAX_OUTPUT_BYTES,
              }),
              child.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { stdout, stderr, code: Number(code) };
        }),
      ).pipe(Effect.timeoutOption(input.timeoutMs));
      if (Option.isNone(collected)) {
        return yield* new OpenCodeRuntimeError({
          operation: "ensureOpenCodeInstalled",
          detail:
            "Automatic OpenCode installation timed out after 5 minutes. The install may still be finishing; refresh provider status to check.",
        });
      }
      return collected.value;
    }).pipe(
      Effect.mapError((cause) =>
        ensureRuntimeError(
          "ensureOpenCodeInstalled",
          `Automatic OpenCode installation failed: ${openCodeRuntimeErrorDetail(cause)}`,
          cause,
        ),
      ),
    );

  // Fresh installs prefer the v2 CLI distribution (`@opencode/cli`, the
  // OpenCode 2 line); when it fails, retry with the v1 line (`opencode-ai`)
  // before giving up — both are supported at runtime via version routing.
  const OPENCODE_NPM_INSTALL_SPECS_IN_ORDER: ReadonlyArray<string> = [
    OPENCODE_NPM_INSTALL_SPEC_V2,
    OPENCODE_NPM_INSTALL_SPEC,
  ];

  const runNpmInstall = (input: {
    readonly managedDir: string;
    readonly environment?: NodeJS.ProcessEnv;
  }): Effect.Effect<void, OpenCodeRuntimeError> =>
    Effect.gen(function* () {
      const npm = yield* resolveExisting("npm", input.environment);
      if (Option.isNone(npm)) {
        return yield* new OpenCodeRuntimeError({
          operation: "ensureOpenCodeInstalled",
          detail:
            "OpenCode CLI (`opencode`) is not installed and npm is unavailable to install it automatically. Install Node.js/npm, or install OpenCode manually: curl -fsSL https://opencode.ai/install | bash",
        });
      }
      const failures: Array<string> = [];
      for (const spec of OPENCODE_NPM_INSTALL_SPECS_IN_ORDER) {
        const { stdout, stderr, code } = yield* runInstallCommand({
          label: "npm",
          command: npm.value,
          args: openCodeNpmInstallArgs(input.managedDir, spec),
          ...(input.environment ? { environment: input.environment } : {}),
          timeoutMs: OPENCODE_NPM_INSTALL_TIMEOUT_MS,
        });
        if (code === 0) {
          yield* Effect.logInfo(`Automatic OpenCode installation used ${spec}.`, {
            managedDir: input.managedDir,
          });
          return;
        }
        const tail = `${stderr}\n${stdout}`.trim().slice(-1024);
        failures.push(`${spec} (npm exited with code ${code})${tail ? `:\n${tail}` : ""}`);
      }
      return yield* new OpenCodeRuntimeError({
        operation: "ensureOpenCodeInstalled",
        detail: `Automatic OpenCode installation failed. Attempts: ${failures.join("; ")}`,
      });
    });

  /**
   * Install without npm by downloading the official release archive with
   * curl and extracting it into `<managedDir>/bin` — the path for machines
   * (most non-developers) that have no Node.js toolchain. Mirrors the
   * platform mapping of the official install script, so macOS and Windows
   * are covered with the OS-preinstalled tools (curl plus unzip/tar on
   * macOS/Linux, curl plus PowerShell on Windows).
   */
  const runScriptInstall = (input: {
    readonly managedDir: string;
    readonly environment?: NodeJS.ProcessEnv;
  }): Effect.Effect<void, OpenCodeRuntimeError> =>
    Effect.gen(function* () {
      const target = openCodeInstallTargetForHost({
        platform: hostPlatform,
        arch: yield* HostProcessArchitecture,
      });
      if (target === null) {
        return yield* new OpenCodeRuntimeError({
          operation: "ensureOpenCodeInstalled",
          detail: `Automatic OpenCode installation is not supported on this machine (${hostPlatform}). Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash`,
        });
      }
      const curl = yield* resolveExisting("curl", input.environment);
      if (Option.isNone(curl)) {
        return yield* new OpenCodeRuntimeError({
          operation: "ensureOpenCodeInstalled",
          detail:
            "OpenCode CLI (`opencode`) is not installed, and neither npm nor curl is available to install it automatically. Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash",
        });
      }
      const extract = openCodeArchiveExtractCommand({
        platform: hostPlatform,
        archivePath: "",
        destDir: "",
      });
      if (extract === null) {
        return yield* new OpenCodeRuntimeError({
          operation: "ensureOpenCodeInstalled",
          detail: `Automatic OpenCode installation is not supported on this machine (${hostPlatform}). Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash`,
        });
      }
      const extractor = yield* resolveExisting(extract.command, input.environment);
      if (Option.isNone(extractor)) {
        const missing =
          hostPlatform === "win32" ? "PowerShell" : hostPlatform === "darwin" ? "unzip" : "tar";
        return yield* new OpenCodeRuntimeError({
          operation: "ensureOpenCodeInstalled",
          detail: `OpenCode CLI (\`opencode\`) is not installed, and ${missing} is unavailable to finish the automatic install. Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash`,
        });
      }
      const tmpDir = pathService.join(input.managedDir, "install-tmp");
      const cleanupTmp = fs.remove(tmpDir, { recursive: true }).pipe(Effect.ignore);
      yield* fs
        .makeDirectory(tmpDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            ensureRuntimeError(
              "ensureOpenCodeInstalled",
              `Could not prepare the managed OpenCode directory at ${input.managedDir}: ${openCodeRuntimeErrorDetail(cause)}`,
              cause,
            ),
          ),
        );
      yield* Effect.gen(function* () {
        const archivePath = pathService.join(tmpDir, openCodeInstallArchiveFilename(target));
        const extractDir = pathService.join(tmpDir, "extracted");
        yield* fs.makeDirectory(extractDir, { recursive: true });
        const download = yield* runInstallCommand({
          label: "curl",
          command: curl.value,
          args: openCodeCurlDownloadArgs(openCodeInstallDownloadUrl(target), archivePath),
          ...(input.environment ? { environment: input.environment } : {}),
          timeoutMs: OPENCODE_SCRIPT_INSTALL_TIMEOUT_MS,
        });
        if (download.code !== 0) {
          return yield* new OpenCodeRuntimeError({
            operation: "ensureOpenCodeInstalled",
            detail: `Automatic OpenCode installation failed (could not download the release archive). Check network access, or install OpenCode manually: curl -fsSL https://opencode.ai/install | bash`,
          });
        }
        const extractCommand = openCodeArchiveExtractCommand({
          platform: hostPlatform,
          archivePath,
          destDir: extractDir,
        });
        if (extractCommand === null) {
          return yield* new OpenCodeRuntimeError({
            operation: "ensureOpenCodeInstalled",
            detail: `Automatic OpenCode installation is not supported on this machine (${hostPlatform}). Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash`,
          });
        }
        const extracted = yield* runInstallCommand({
          label: extractCommand.command,
          command: extractor.value,
          args: extractCommand.args,
          ...(input.environment ? { environment: input.environment } : {}),
          timeoutMs: OPENCODE_SCRIPT_INSTALL_TIMEOUT_MS,
        });
        if (extracted.code !== 0) {
          const tail = `${extracted.stderr}\n${extracted.stdout}`.trim().slice(-1024);
          return yield* new OpenCodeRuntimeError({
            operation: "ensureOpenCodeInstalled",
            detail: `Automatic OpenCode installation failed (could not unpack the release archive).${tail ? ` Output:\n${tail}` : ""} Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash`,
          });
        }
        let staged: string | null = null;
        for (const name of openCodeExtractedBinaryNames(hostPlatform)) {
          const candidate = pathService.join(extractDir, name);
          if (yield* fs.exists(candidate)) {
            staged = candidate;
            break;
          }
        }
        if (staged === null) {
          return yield* new OpenCodeRuntimeError({
            operation: "ensureOpenCodeInstalled",
            detail:
              "Automatic OpenCode installation failed (the downloaded archive did not contain an opencode binary). Install OpenCode manually: curl -fsSL https://opencode.ai/install | bash",
          });
        }
        const binDir = openCodeManagedScriptBinDir(input.managedDir);
        yield* fs.makeDirectory(binDir, { recursive: true });
        const destination = openCodeManagedScriptBinaryPath(input.managedDir, hostPlatform);
        yield* fs
          .rename(staged, destination)
          .pipe(
            Effect.mapError((cause) =>
              ensureRuntimeError(
                "ensureOpenCodeInstalled",
                `Could not place the downloaded OpenCode binary at ${destination}: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              ),
            ),
          );
        if (hostPlatform !== "win32") {
          yield* fs.chmod(destination, 0o755).pipe(Effect.ignore);
        }
      }).pipe(
        Effect.ensuring(cleanupTmp),
        Effect.mapError((cause) =>
          ensureRuntimeError(
            "ensureOpenCodeInstalled",
            `Automatic OpenCode installation failed: ${openCodeRuntimeErrorDetail(cause)}`,
            cause,
          ),
        ),
      );
    });

  const ensureOpenCodeInstalled: OpenCodeRuntimeShape["ensureOpenCodeInstalled"] = (input) =>
    installLock.withPermit(
      Effect.gen(function* () {
        const environment = input.environment;
        const candidates = openCodeBinaryCandidates({
          binaryPath: input.binaryPath,
          ...(environment !== undefined ? { environment } : {}),
          ...(input.managedDir !== undefined ? { managedDir: input.managedDir } : {}),
          platform: hostPlatform,
        });
        const existing = yield* firstExisting(candidates, environment);
        if (existing !== null) {
          return {
            binaryPath: existing,
            freshInstall: false,
          } satisfies EnsureOpenCodeInstallResult;
        }
        // A custom binary path is the user's explicit choice: report it
        // missing rather than installing something they did not ask for.
        if (!isDefaultOpenCodeBinary(input.binaryPath)) {
          return yield* new OpenCodeRuntimeError({
            operation: "ensureOpenCodeInstalled",
            detail: `Custom OpenCode binary '${input.binaryPath.trim()}' was not found.`,
          });
        }
        const managedDir = input.managedDir?.trim();
        if (!managedDir) {
          return yield* new OpenCodeRuntimeError({
            operation: "ensureOpenCodeInstalled",
            detail: "OpenCode CLI (`opencode`) is not installed or not on PATH.",
          });
        }
        yield* Effect.logInfo("OpenCode CLI not found. Installing automatically with npm.", {
          managedDir,
        });
        yield* fs
          .makeDirectory(managedDir, { recursive: true })
          .pipe(
            Effect.mapError((cause) =>
              ensureRuntimeError(
                "ensureOpenCodeInstalled",
                `Could not create the managed OpenCode directory at ${managedDir}: ${openCodeRuntimeErrorDetail(cause)}`,
                cause,
              ),
            ),
          );
        // npm first; without it (the usual non-developer machine), download
        // the official release archive with curl instead.
        const npm = yield* resolveExisting("npm", environment);
        if (Option.isSome(npm)) {
          yield* Effect.logInfo("OpenCode CLI not found. Installing automatically with npm.", {
            managedDir,
          });
          const manifestPath = pathService.join(managedDir, "package.json");
          if (!(yield* fs.exists(manifestPath))) {
            yield* fs
              .writeFileString(manifestPath, openCodeManagedPackageJson())
              .pipe(
                Effect.mapError((cause) =>
                  ensureRuntimeError(
                    "ensureOpenCodeInstalled",
                    `Could not prepare the managed OpenCode directory at ${managedDir}: ${openCodeRuntimeErrorDetail(cause)}`,
                    cause,
                  ),
                ),
              );
          }
          yield* runNpmInstall({
            managedDir,
            ...(environment !== undefined ? { environment } : {}),
          });
        } else {
          yield* Effect.logInfo(
            "OpenCode CLI not found and npm is unavailable. Installing automatically by downloading the official release.",
            { managedDir },
          );
          yield* runScriptInstall({
            managedDir,
            ...(environment !== undefined ? { environment } : {}),
          });
        }
        const installed = yield* firstExisting(
          [
            openCodeManagedBinaryPath(managedDir, hostPlatform),
            openCodeManagedScriptBinaryPath(managedDir, hostPlatform),
          ],
          environment,
        );
        if (installed === null) {
          return yield* new OpenCodeRuntimeError({
            operation: "ensureOpenCodeInstalled",
            detail:
              "The automatic OpenCode install finished but the OpenCode binary is still missing. Install it manually: curl -fsSL https://opencode.ai/install | bash",
          });
        }
        yield* Effect.logInfo("OpenCode CLI installed automatically.", {
          binaryPath: installed,
        });
        return {
          binaryPath: installed,
          freshInstall: true,
        } satisfies EnsureOpenCodeInstallResult;
      }).pipe(
        Effect.mapError((cause) =>
          ensureRuntimeError(
            "ensureOpenCodeInstalled",
            `Could not make sure the OpenCode CLI is installed: ${openCodeRuntimeErrorDetail(cause)}`,
            cause,
          ),
        ),
      ),
    );

  return {
    startOpenCodeServerProcess,
    connectToOpenCodeServer,
    runOpenCodeCommand,
    createOpenCodeSdkClient,
    loadOpenCodeInventory,
    loadOpenCodeSkills,
    loadInventoryFromCli,
    loadSkillsFromCli,
    ensureOpenCodeInstalled,
  } satisfies OpenCodeRuntimeShape;
});

export class OpenCodeRuntime extends Context.Service<OpenCodeRuntime, OpenCodeRuntimeShape>()(
  "@lag4/doer-cli/provider/opencodeRuntime",
) {}

export const OpenCodeRuntimeLive = Layer.effect(OpenCodeRuntime, makeOpenCodeRuntime).pipe(
  Layer.provide(NetService.layer),
);
