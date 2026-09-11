/**
 * OpenCodeInstall — locating and bootstrapping the OpenCode CLI.
 *
 * T3 Code shells out to an `opencode` binary for version probes, the local
 * server, and CLI inventory. A bare `"opencode"` resolves through PATH, which
 * GUI-launched servers (desktop app, launchd/systemd units) often see
 * sparsely — even when the user installed OpenCode via the official script
 * (it lands in `~/.opencode/bin`, which login shells add to PATH but GUI
 * processes never see). This module lists every location worth checking, in
 * priority order, and knows how to install the CLI into a T3-managed
 * directory (`<baseDir>/tools/opencode`) with npm when nothing is found.
 *
 * The managed install deliberately avoids global state: `npm install
 * --prefix <managedDir>` keeps the binary under T3's home directory, so no
 * sudo, no user-global mutation, and removal is a directory delete. The
 * official install script's `~/.opencode/bin` location stays a read-only
 * detection fallback — T3 never writes there.
 *
 * @module provider/opencodeInstall
 */
// @effect-diagnostics nodeBuiltinImport:off - Path helpers here are pure and
// service-free on purpose (resolution order is unit-tested without a runtime).
// They only ever join host paths, where node:path matches the host platform.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const DEFAULT_OPENCODE_BINARY = "opencode";
export const OPENCODE_NPM_PACKAGE = "opencode-ai";
export const OPENCODE_NPM_INSTALL_SPEC = `${OPENCODE_NPM_PACKAGE}@latest`;
/** Directory name below `<baseDir>/tools` holding the T3-managed install. */
export const OPENCODE_MANAGED_TOOL_DIRNAME = "opencode";

/** True when the caller left the stock `"opencode"` command in place. */
export function isDefaultOpenCodeBinary(binaryPath: string | null | undefined): boolean {
  const trimmed = binaryPath?.trim() ?? "";
  return trimmed.length === 0 || trimmed === DEFAULT_OPENCODE_BINARY;
}

/** `<baseDir>/tools/opencode` — the root npm `--prefix` owns. */
export function openCodeManagedDir(baseDir: string): string {
  return NodePath.join(baseDir, "tools", OPENCODE_MANAGED_TOOL_DIRNAME);
}

/** `<managedDir>/node_modules/.bin` — where npm links the executable. */
export function openCodeManagedBinDir(managedDir: string): string {
  return NodePath.join(managedDir, "node_modules", ".bin");
}

/** Absolute path of the T3-managed `opencode` executable for a platform. */
export function openCodeManagedBinaryPath(managedDir: string, platform: NodeJS.Platform): string {
  return NodePath.join(
    openCodeManagedBinDir(managedDir),
    platform === "win32" ? "opencode.cmd" : "opencode",
  );
}

/** Home directory honoring the caller-provided environment first. */
export function resolveOpenCodeHome(
  environment: Readonly<Record<string, string | undefined>> | undefined,
  platform: NodeJS.Platform,
): string | null {
  const home = platform === "win32" ? environment?.USERPROFILE?.trim() : environment?.HOME?.trim();
  if (home) {
    return home;
  }
  try {
    const fallback = NodeOS.homedir().trim();
    return fallback.length > 0 ? fallback : null;
  } catch {
    return null;
  }
}

/**
 * Where the official `curl … https://opencode.ai/install | bash` script puts
 * the binary when no install-directory override is set.
 */
export function openCodeNativeBinaryPath(home: string, platform: NodeJS.Platform): string {
  return NodePath.join(
    home,
    ".opencode",
    "bin",
    platform === "win32" ? "opencode.exe" : "opencode",
  );
}

export interface OpenCodeBinaryCandidatesInput {
  readonly binaryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly managedDir?: string | null;
  readonly platform: NodeJS.Platform;
}

/**
 * Ordered locations to try for an OpenCode binary. A custom `binaryPath` is
 * returned verbatim (the user's explicit choice wins and is never
 * second-guessed); the default resolves through PATH first, then the
 * official script's `~/.opencode/bin`, then the T3-managed install.
 */
export function openCodeBinaryCandidates(
  input: OpenCodeBinaryCandidatesInput,
): ReadonlyArray<string> {
  const configured = input.binaryPath.trim();
  if (!isDefaultOpenCodeBinary(configured)) {
    return [configured];
  }
  const candidates = [DEFAULT_OPENCODE_BINARY];
  const home = resolveOpenCodeHome(input.environment, input.platform);
  if (home) {
    candidates.push(openCodeNativeBinaryPath(home, input.platform));
  }
  const managedDir = input.managedDir?.trim();
  if (managedDir) {
    candidates.push(openCodeManagedBinaryPath(managedDir, input.platform));
  }
  return candidates;
}

/** `npm install` argv that drops the CLI into the managed directory. */
export function openCodeNpmInstallArgs(managedDir: string): ReadonlyArray<string> {
  return [
    "install",
    "--prefix",
    managedDir,
    // npm blocks install scripts by default while exiting 0; opencode-ai's
    // postinstall copies the platform binary into place, so without this the
    // install "succeeds" but leaves a broken binary (same reason the provider
    // update commands pass --allow-scripts).
    `--allow-scripts=${OPENCODE_NPM_PACKAGE}`,
    "--no-audit",
    "--no-fund",
    OPENCODE_NPM_INSTALL_SPEC,
  ];
}

/** Minimal `package.json` so `npm --prefix` has a project to work in. */
export function openCodeManagedPackageJson(): string {
  return `${JSON.stringify(
    {
      name: "t3-managed-opencode",
      private: true,
      description: "T3 Code-managed OpenCode CLI install. Safe to delete; it reinstalls on demand.",
    },
    null,
    2,
  )}\n`;
}
