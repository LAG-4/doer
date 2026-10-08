/**
 * OpenCode data-home isolation — keeps Doer's OpenCode runtime off the
 * user's shared global database.
 *
 * `opencode serve` opens `$XDG_DATA_HOME/opencode/opencode.db` (default
 * `~/.local/share/opencode/opencode.db`) and exits when that file is
 * non-empty but has an unexpected schema — e.g. after another OpenCode app
 * migrated it (`Database is not empty and has no session table`). Pointing
 * Doer's spawns at a Doer-owned directory gives them a fresh database that
 * no other app touches, while the user's global install keeps working.
 * `XDG_DATA_HOME` is consulted first on every platform (verified in the
 * bundled `Global` path code: `process.env.XDG_DATA_HOME ||
 * homedir/.local/share`, no platform branch), so the shadow applies
 * uniformly; WSL servers are Linux and covered the same way.
 *
 * The data dir also holds v1 `auth.json` (`auth list` prints
 * `$XDG_DATA_HOME/opencode/auth.json` as its credentials path), so an
 * existing global auth file is imported once with a secure one-time copy:
 * never overwritten afterwards, never blocking the free default when
 * absent. A copy — not a symlink — because provider SDK token refreshes can
 * rewrite auth in place, which would write the user's global tokens through
 * a link. The global database itself is never copied or migrated.
 *
 * An explicit instance-configured `XDG_DATA_HOME` is honored verbatim — no
 * shadowing. Ambient (inherited) `XDG_DATA_HOME` never disables isolation
 * (Linux commonly sets it globally, which is exactly the colliding
 * location); it only locates the global auth/native history to import from.
 *
 * @module provider/openCodeDataHome
 */
// @effect-diagnostics nodeBuiltinImport:off - Path joins here are pure and
// service-free on purpose (resolution is unit-tested without a runtime).
// They only ever join host paths, where node:path matches the host platform.
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveOpenCodeHome } from "./opencodeInstall.ts";

export const OPENCODE_XDG_DATA_HOME_VAR = "XDG_DATA_HOME" as const;
const OPENCODE_DATA_DIR_NAME = "opencode";
const OPENCODE_AUTH_FILENAME = "auth.json";
const AUTH_FILE_MODE = 0o600;

export interface OpenCodeDataHomeResolution {
  /**
   * Effective `XDG_DATA_HOME` for OpenCode child processes. `undefined`
   * only when the home directory is unknown and no explicit value exists.
   */
  readonly dataHome: string | undefined;
  /**
   * Global data dir used only to locate an existing `auth.json` to import.
   * `undefined` when unknown or when the caller configured the data home
   * explicitly.
   */
  readonly globalDataDir: string | undefined;
  /** True when the caller configured `XDG_DATA_HOME` explicitly. */
  readonly explicit: boolean;
}

/**
 * Collision-safe namespace for one provider instance inside the Doer data
 * home. `encodeURIComponent` escapes `/`, `\`, and `:` (Windows-unfriendly),
 * and all-dot ids are escaped so `..` can never join outside the data dir.
 * Shared by the driver shadow path and usage-scan roots.
 */
export function openCodeDataNamespace(instanceId: string): string {
  const encoded = encodeURIComponent(instanceId.length > 0 ? instanceId : "default");
  const dotted = /^\.+$/.test(encoded) ? encoded.replace(/\./g, "%2E") : encoded;
  return `instance-${dotted}`;
}

/**
 * Resolve the data home for OpenCode child processes. Pure: pass the
 * instance's configured environment entries separately from the merged
 * (ambient + instance) environment. Only an instance-configured
 * `XDG_DATA_HOME` bypasses isolation, returned verbatim (only trimmed to
 * test for empty); leading/trailing spaces are part of the path and
 * preserved. Ambient `XDG_DATA_HOME` selects the global auth source instead.
 */
export function resolveOpenCodeDataHome(input: {
  readonly instanceEnvironment:
    | ReadonlyArray<{ readonly name: string; readonly value: string }>
    | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly managedDir: string;
  readonly instanceId: string;
  readonly platform: NodeJS.Platform;
}): OpenCodeDataHomeResolution {
  const override = input.instanceEnvironment?.find(
    (variable) =>
      variable.name.trim() === OPENCODE_XDG_DATA_HOME_VAR && variable.value.trim().length > 0,
  )?.value;
  if (override !== undefined) {
    return { dataHome: override, globalDataDir: undefined, explicit: true };
  }
  const home = resolveOpenCodeHome(input.environment, input.platform);
  if (!home) {
    return { dataHome: undefined, globalDataDir: undefined, explicit: false };
  }
  const ambientDataHome = input.environment[OPENCODE_XDG_DATA_HOME_VAR]?.trim();
  return {
    dataHome: NodePath.join(input.managedDir, "data", openCodeDataNamespace(input.instanceId)),
    globalDataDir:
      ambientDataHome && ambientDataHome.length > 0
        ? ambientDataHome
        : NodePath.join(home, ".local", "share"),
    explicit: false,
  };
}

/**
 * Materialize a resolved shadow: create the data dir and import the global
 * `auth.json` once when the shadow has none. The import is a single
 * exclusive `wx` write with owner-only mode: concurrent first-boots race
 * safely (exactly one wins; the loser keeps the winner's file), and the
 * credentials are never exposed with default permissions in between.
 * Best-effort throughout — auth is optional for the free default, so a
 * failed import never fails setup. Never touches the global database.
 */
export const ensureOpenCodeDataHome = Effect.fn("ensureOpenCodeDataHome")(function* (
  resolution: OpenCodeDataHomeResolution,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  if (resolution.dataHome === undefined || resolution.explicit) {
    return resolution.dataHome;
  }
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const scopedDir = path.join(resolution.dataHome, OPENCODE_DATA_DIR_NAME);
  yield* fileSystem.makeDirectory(scopedDir, { recursive: true }).pipe(Effect.ignore);
  if (resolution.globalDataDir !== undefined) {
    const source = path.join(
      resolution.globalDataDir,
      OPENCODE_DATA_DIR_NAME,
      OPENCODE_AUTH_FILENAME,
    );
    const dest = path.join(scopedDir, OPENCODE_AUTH_FILENAME);
    yield* Effect.gen(function* () {
      const info = yield* fileSystem.stat(source);
      if (info.type !== "File") {
        return;
      }
      const contents = yield* fileSystem.readFile(source);
      // `wx` fails when the destination already exists, so a pre-existing
      // shadow file (or a concurrent first-boot winner) is never
      // overwritten; `mode` lands owner-only from creation, subject only to
      // bits the process umask removes (none of 0o600's).
      yield* fileSystem.writeFile(dest, contents, { flag: "wx", mode: AUTH_FILE_MODE });
    }).pipe(Effect.ignore);
  }
  return resolution.dataHome;
});

/**
 * Usage-scan roots for Doer's OpenCode namespaces, one per instance.
 *
 * Semantics mirror the runtime exactly: an instance-configured
 * `XDG_DATA_HOME` is an XDG root, so `opencode` is always appended (even
 * when the value itself ends in `/opencode` — the child data really lives
 * at `/opencode/opencode`). `OPENCODE_DATA_DIR` is a legacy usage-scan-only
 * override the runtime does not recognize, so it is scanned as-is
 * *alongside* the actual shadow root rather than substituting for it.
 * Values are used verbatim (spaces preserved), matching the runtime.
 */
export function resolveOpenCodeShadowUsageRoots(input: {
  readonly managedDir: string;
  readonly instances: ReadonlyArray<{
    readonly instanceId: string;
    readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  }>;
}): ReadonlyArray<string> {
  const roots: Array<string> = [];
  for (const instance of input.instances) {
    const configured = (name: string) =>
      instance.environment.find(
        (variable) => variable.name.trim() === name && variable.value.trim().length > 0,
      )?.value;
    const xdg = configured(OPENCODE_XDG_DATA_HOME_VAR);
    if (xdg !== undefined) {
      roots.push(NodePath.join(xdg, OPENCODE_DATA_DIR_NAME));
      continue;
    }
    roots.push(
      NodePath.join(
        input.managedDir,
        "data",
        openCodeDataNamespace(instance.instanceId),
        OPENCODE_DATA_DIR_NAME,
      ),
    );
    const legacy = configured("OPENCODE_DATA_DIR");
    if (legacy !== undefined) {
      roots.push(legacy);
    }
  }
  return roots;
}
