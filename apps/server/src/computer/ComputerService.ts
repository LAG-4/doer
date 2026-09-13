/**
 * Computer use: Codex-style desktop control for agents.
 *
 * The heavy lifting (screenshots, accessibility trees, input injection,
 * per-OS runtimes) lives in the pinned `open-computer-use` CLI installed by
 * `ComputerToolchain`. This service owns the Doer side: install lifecycle,
 * the user's per-app allow list (Codex's "Always allow"), status/doctor
 * reporting, and the `get_app_state` observe call whose screenshot travels
 * back as image content.
 *
 * Driving (click/type/press) happens through the `computer-use` launcher on
 * the provider PATH (see `ComputerShim`), which enforces the same allow list
 * for CLI-direct calls. Wrapping every upstream tool here would only lag
 * behind its releases — the same call the `device_*` tools made.
 */
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  type ComputerToolchainInstallError,
  computerUseEntryPath,
  ensureComputerUse,
  isComputerUseInstalled,
} from "./ComputerToolchain.ts";

const COMPUTER_ALLOWLIST_VERSION = 1;

const AllowlistFile = Schema.Struct({
  version: Schema.Literal(1),
  apps: Schema.Array(Schema.String),
});
const decodeAllowlistFileBody = Schema.decodeUnknownSync(AllowlistFile);

export interface ComputerPermissions {
  readonly accessibility: boolean;
  readonly screenRecording: boolean;
}

export interface ComputerStatus {
  readonly supported: boolean;
  readonly platform: string;
  readonly cliInstalled: boolean;
  readonly cliVersion: string | undefined;
  readonly permissions: ComputerPermissions | undefined;
  readonly onboardingNeeded: boolean;
  readonly allowedApps: ReadonlyArray<string>;
}

export interface ComputerStart {
  readonly entryPath: string;
  readonly needsPermission: boolean;
  readonly permissions: ComputerPermissions | undefined;
  readonly appAllowed: boolean;
  readonly platformNote: string;
}

export interface ComputerObservation {
  readonly app: string;
  readonly tree: string;
  readonly png: Uint8Array;
}

export class ComputerUseError extends Schema.TaggedError<ComputerUseError>()("ComputerUseError", {
  operation: Schema.String,
  reason: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Computer use failed while ${this.operation}: ${this.reason}`;
  }
}

export class ComputerService extends Context.Service<
  ComputerService,
  {
    /** Read-only probe: never installs, never prompts, never launches helpers. */
    readonly status: Effect.Effect<ComputerStatus, ComputerUseError>;
    /** Absolute path of the pinned `ocu` launcher, installing first if needed. */
    readonly cliEntry: Effect.Effect<string, ComputerUseError | ComputerToolchainInstallError>;
    /** Install + doctor + consent bookkeeping for one target app (or none). */
    readonly start: (input: {
      readonly app?: string | undefined;
    }) => Effect.Effect<ComputerStart, ComputerUseError | ComputerToolchainInstallError>;
    /** Record the user's approval to operate an app. */
    readonly allow: (app: string) => Effect.Effect<ReadonlyArray<string>, ComputerUseError>;
    /** Revoke one app, or every app when omitted. */
    readonly forget: (input: {
      readonly app?: string | undefined;
    }) => Effect.Effect<ReadonlyArray<string>, ComputerUseError>;
    readonly allowedApps: Effect.Effect<ReadonlyArray<string>, ComputerUseError>;
    readonly isAllowed: (app: string) => Effect.Effect<boolean, ComputerUseError>;
    /** Screenshot + accessibility tree for an approved app. */
    readonly observe: (input: {
      readonly app: string;
      readonly textLimit?: number | "max" | undefined;
      readonly maxTreeNodes?: number | undefined;
      readonly maxTreeDepth?: number | undefined;
    }) => Effect.Effect<ComputerObservation, ComputerUseError | ComputerToolchainInstallError>;
  }
>()("@lag4/doer-cli/computer/ComputerService") {}

const OBSERVE_TIMEOUT = Duration.minutes(2);
const DOCTOR_TIMEOUT = Duration.minutes(2);

const normalizeApp = (app: string): string => app.trim();

const matchesAllowlist = (allowed: ReadonlyArray<string>, app: string): boolean => {
  const wanted = normalizeApp(app).toLowerCase();
  if (wanted.length === 0) return false;
  return allowed.some((entry) => entry.toLowerCase() === wanted);
};

const dedupeApps = (apps: ReadonlyArray<string>): Array<string> => {
  const seen = new Set<string>();
  const out: Array<string> = [];
  for (const app of apps) {
    const name = normalizeApp(app);
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
};

/** Parse the allow-list file; any corrupt or missing content means no approvals. */
const decodeAllowlistFile = (text: string): ReadonlyArray<string> => {
  try {
    return dedupeApps(decodeAllowlistFileBody(JSON.parse(text)).apps);
  } catch {
    return [];
  }
};

const encodeAllowlistFile = (apps: ReadonlyArray<string>): string =>
  `${JSON.stringify({ version: COMPUTER_ALLOWLIST_VERSION, apps: dedupeApps(apps) })}\n`;

/** `doctor` prints `Permissions: accessibility=granted|missing, screenRecording=granted|missing`. */
export function parseDoctorPermissions(output: string): ComputerPermissions | undefined {
  const match =
    /accessibility\s*=\s*(granted|missing)[^a-z]*screen\s*recording\s*=\s*(granted|missing)/i.exec(
      output,
    );
  if (!match) return undefined;
  return {
    accessibility: match[1]!.toLowerCase() === "granted",
    screenRecording: match[2]!.toLowerCase() === "granted",
  };
}

const encodeCallArgs = (args: Record<string, unknown>): string => JSON.stringify(args);

const OBSERVE_UNSUPPORTED_MESSAGE =
  "Computer use needs a logged-in desktop session on this machine.";

const platformNoteFor = (platform: string): string =>
  platform === "win32"
    ? "On Windows computer use takes over the foreground: the pointer will move and type while it runs. Keep this desktop visible and unlocked, close sensitive apps you do not need, and stop the task before using the computer yourself."
    : platform === "darwin"
      ? "On macOS computer use normally works in the background without moving your pointer. Grant Accessibility and Screen Recording to Open Computer Use when prompted."
      : "On Linux computer use needs a logged-in graphical session. Screenshot and coordinate input support is compositor-dependent and best-effort.";

const supportedPlatform = (platform: string): boolean =>
  platform === "darwin" || platform === "win32" || platform === "linux";

interface CallResultContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
}

const extractObservation = (
  stdout: string,
): { readonly tree: string; readonly png: Uint8Array } | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const content = (parsed as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const items = content as ReadonlyArray<CallResultContent>;
  const tree = items.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  const image = items.find((item) => item.type === "image" && typeof item.data === "string");
  if (tree === undefined || image?.data === undefined) return undefined;
  let png: Uint8Array;
  try {
    png = new Uint8Array(Buffer.from(image.data, "base64"));
  } catch {
    return undefined;
  }
  if (png.length === 0) return undefined;
  return { tree, png };
};

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig;
  const lock = yield* Semaphore.make(1);

  const allowlistPath = path.join(config.stateDir, "computer", "allowed-apps.json");

  const readAllowlist: Effect.Effect<ReadonlyArray<string>, ComputerUseError> = Effect.gen(
    function* () {
      const raw = yield* fs.readFileString(allowlistPath).pipe(
        Effect.mapError(
          () => new ComputerUseError({ operation: "reading approvals", reason: "unavailable" }),
        ),
        Effect.option,
      );
      if (raw._tag === "None") return [];
      return decodeAllowlistFile(raw.value);
    },
  );

  const writeAllowlist = (
    apps: ReadonlyArray<string>,
  ): Effect.Effect<ReadonlyArray<string>, ComputerUseError> =>
    Effect.gen(function* () {
      const next = dedupeApps(apps);
      yield* fs.makeDirectory(path.dirname(allowlistPath), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ComputerUseError({
              operation: "recording approval",
              reason: "unavailable",
              cause,
            }),
        ),
      );
      const staging = `${allowlistPath}.tmp`;
      yield* fs.writeFileString(staging, encodeAllowlistFile(next)).pipe(
        Effect.mapError(
          (cause) =>
            new ComputerUseError({
              operation: "recording approval",
              reason: "unavailable",
              cause,
            }),
        ),
      );
      yield* fs.rename(staging, allowlistPath).pipe(
        Effect.mapError(
          (cause) =>
            new ComputerUseError({
              operation: "recording approval",
              reason: "unavailable",
              cause,
            }),
        ),
      );
      return next;
    });

  const withAllowlist = <A, E>(
    update: (current: ReadonlyArray<string>) => Effect.Effect<A, E>,
  ): Effect.Effect<A, E | ComputerUseError> =>
    lock.withPermit(Effect.flatMap(readAllowlist, update));

  const runEntry = (
    entryPath: string,
    args: ReadonlyArray<string>,
    operation: string,
    timeout: Duration.Duration,
  ): Effect.Effect<ProcessRunner.ProcessRunOutput, ComputerUseError> =>
    runner
      .run({ command: process.execPath, args: [entryPath, ...args], timeout })
      .pipe(
        Effect.mapError(
          (cause) => new ComputerUseError({ operation, reason: "could not launch", cause }),
        ),
      );

  const readCliVersion = (entryPath: string): Effect.Effect<string | undefined, never> =>
    Effect.gen(function* () {
      const result = yield* runEntry(entryPath, ["version"], "checking version", DOCTOR_TIMEOUT);
      if (result.code !== 0) return undefined;
      const version = result.stdout.trim().split("\n", 1)[0]?.trim();
      return version === undefined || version.length === 0 ? undefined : version;
    }).pipe(Effect.orElseSucceed(() => undefined));

  const status: ComputerService["Service"]["status"] = Effect.gen(function* () {
    const allowed = yield* readAllowlist;
    const supported = supportedPlatform(platform);
    if (!supported) {
      return {
        supported,
        platform,
        cliInstalled: false,
        cliVersion: undefined,
        permissions: undefined,
        onboardingNeeded: true,
        allowedApps: allowed,
      } satisfies ComputerStatus;
    }
    const installed = yield* isComputerUseInstalled(config.baseDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (!installed) {
      return {
        supported,
        platform,
        cliInstalled: false,
        cliVersion: undefined,
        permissions: undefined,
        onboardingNeeded: true,
        allowedApps: allowed,
      } satisfies ComputerStatus;
    }
    const version = yield* readCliVersion(computerUseEntryPath(path, config.baseDir));
    return {
      supported,
      platform,
      cliInstalled: true,
      cliVersion: version,
      permissions: undefined,
      onboardingNeeded: true,
      allowedApps: allowed,
    } satisfies ComputerStatus;
  });

  const cliEntry: ComputerService["Service"]["cliEntry"] = Effect.gen(function* () {
    const paths = yield* ensureComputerUse(config.baseDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
    );
    return paths.entryPath;
  });

  const start: ComputerService["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      if (!supportedPlatform(platform)) {
        return yield* new ComputerUseError({
          operation: "starting computer use",
          reason: OBSERVE_UNSUPPORTED_MESSAGE,
        });
      }
      const entryPath = yield* cliEntry;
      const doctor = yield* runEntry(entryPath, ["doctor"], "checking permissions", DOCTOR_TIMEOUT);
      const combined = `${doctor.stdout}\n${doctor.stderr}`;
      const permissions = parseDoctorPermissions(combined);
      const needsPermission =
        permissions === undefined
          ? true
          : !permissions.accessibility || !permissions.screenRecording;
      const allowed = yield* readAllowlist;
      const app = input.app === undefined ? undefined : normalizeApp(input.app);
      if (app !== undefined && app.length > 0 && !matchesAllowlist(allowed, app)) {
        return yield* new ComputerUseError({
          operation: "starting computer use",
          reason:
            `The user has not approved "${app}" yet. Ask them for permission to see and operate it, ` +
            `and when they agree, call computer_allow for "${app}" first. Never drive an app the user did not approve.`,
        });
      }
      return {
        entryPath,
        needsPermission,
        permissions,
        appAllowed: app === undefined || app.length === 0 ? true : matchesAllowlist(allowed, app),
        platformNote: platformNoteFor(platform),
      } satisfies ComputerStart;
    });

  const allow: ComputerService["Service"]["allow"] = (app) =>
    Effect.gen(function* () {
      const name = normalizeApp(app);
      if (name.length === 0) {
        return yield* new ComputerUseError({
          operation: "recording approval",
          reason: "Pass the app name or bundle identifier the user approved.",
        });
      }
      return yield* withAllowlist((current) => writeAllowlist([...current, name]));
    });

  const forget: ComputerService["Service"]["forget"] = (input) =>
    Effect.gen(function* () {
      return yield* withAllowlist((current) => {
        if (input.app === undefined) return writeAllowlist([]);
        const name = normalizeApp(input.app).toLowerCase();
        return writeAllowlist(current.filter((entry) => entry.toLowerCase() !== name));
      });
    });

  const allowedApps: ComputerService["Service"]["allowedApps"] = readAllowlist;

  const isAllowed: ComputerService["Service"]["isAllowed"] = (app) =>
    Effect.gen(function* () {
      return matchesAllowlist(yield* readAllowlist, app);
    });

  const observe: ComputerService["Service"]["observe"] = (input) =>
    Effect.gen(function* () {
      if (!supportedPlatform(platform)) {
        return yield* new ComputerUseError({
          operation: "observing app",
          reason: OBSERVE_UNSUPPORTED_MESSAGE,
        });
      }
      const app = normalizeApp(input.app);
      if (app.length === 0) {
        return yield* new ComputerUseError({
          operation: "observing app",
          reason: "Pass the app name or bundle identifier to observe.",
        });
      }
      if (!matchesAllowlist(yield* readAllowlist, app)) {
        return yield* new ComputerUseError({
          operation: "observing app",
          reason:
            `The user has not approved "${app}" yet. Ask them for permission to see and operate it, ` +
            `and when they agree, call computer_allow for "${app}" first.`,
        });
      }
      const entryPath = yield* cliEntry;
      const args: Record<string, unknown> = { app };
      if (input.textLimit !== undefined) args["text_limit"] = input.textLimit;
      if (input.maxTreeNodes !== undefined) args["max_tree_nodes"] = input.maxTreeNodes;
      if (input.maxTreeDepth !== undefined) args["max_tree_depth"] = input.maxTreeDepth;
      const result = yield* runEntry(
        entryPath,
        ["call", "get_app_state", "--args", encodeCallArgs(args)],
        "observing app",
        OBSERVE_TIMEOUT,
      );
      if (result.code !== 0) {
        return yield* new ComputerUseError({
          operation: "observing app",
          reason: result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`,
          exitCode: typeof result.code === "number" ? result.code : undefined,
        });
      }
      const observation = extractObservation(result.stdout);
      if (!observation) {
        return yield* new ComputerUseError({
          operation: "observing app",
          reason:
            "The helper returned an unexpected result. Ask the user to run `computer-use doctor` on this machine.",
        });
      }
      return { app, tree: observation.tree, png: observation.png } satisfies ComputerObservation;
    });

  return ComputerService.of({
    status,
    cliEntry,
    start,
    allow,
    forget,
    allowedApps,
    isAllowed,
    observe,
  });
});

export const layer = Layer.effect(ComputerService, make);
