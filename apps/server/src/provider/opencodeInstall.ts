/**
 * OpenCodeInstall — locating and bootstrapping the OpenCode CLI.
 *
 * Doer shells out to an `opencode` binary for version probes, the local
 * server, and CLI inventory. A bare `"opencode"` resolves through PATH, which
 * GUI-launched servers (desktop app, launchd/systemd units) often see
 * sparsely — even when the user installed OpenCode via the official script
 * (it lands in `~/.opencode/bin`, which login shells add to PATH but GUI
 * processes never see). This module lists every location worth checking, in
 * priority order, and knows how to install the CLI into a T3-managed
 * directory (`<baseDir>/tools/opencode`) when nothing is found.
 *
 * Two install methods, tried in order:
 *   1. `npm install --prefix <managedDir>` (needs npm on PATH) — keeps the
 *      binary under T3's home directory, so no sudo, no user-global
 *      mutation, and removal is a directory delete.
 *   2. Direct download of the official release archive with curl, mirroring
 *      the platform mapping of the `https://opencode.ai/install` script —
 *      for machines (most non-developers) with no npm at all. The binary
 *      lands in `<managedDir>/bin`, next to the npm tree, never in
 *      `~/.opencode/bin`.
 *
 * The official install script's `~/.opencode/bin` location stays a read-only
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
/**
 * v2 CLI distribution. Fresh automatic installs prefer this: `@opencode/cli`
 * tracks the OpenCode 2 line (`opencode-ai@latest` still publishes the v1
 * line), and the package bundles the native binary — no post-install
 * download step. Falls back to {@link OPENCODE_NPM_INSTALL_SPEC} (v1) when
 * the v2 install fails; both are supported at runtime via version routing.
 */
export const OPENCODE_NPM_PACKAGE_V2 = "@opencode/cli";
export const OPENCODE_NPM_INSTALL_SPEC_V2 = `${OPENCODE_NPM_PACKAGE_V2}@latest`;
/** Directory name below `<baseDir>/tools` holding the T3-managed install. */
export const OPENCODE_MANAGED_TOOL_DIRNAME = "opencode";
/** The official install script — the fallback install mirrors its platform mapping. */
export const OPENCODE_INSTALL_SCRIPT_URL = "https://opencode.ai/install";
/** Release downloads live here; the script uses `.../latest/download/<filename>`. */
export const OPENCODE_RELEASE_DOWNLOAD_BASE_URL =
  "https://github.com/anomalyco/opencode/releases/latest/download";

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

/** `<managedDir>/bin` — home of the script-downloaded binary (no npm involved). */
export function openCodeManagedScriptBinDir(managedDir: string): string {
  return NodePath.join(managedDir, "bin");
}

/** Absolute path of the T3-managed `opencode` executable for a platform. */
export function openCodeManagedBinaryPath(managedDir: string, platform: NodeJS.Platform): string {
  return NodePath.join(
    openCodeManagedBinDir(managedDir),
    platform === "win32" ? "opencode.cmd" : "opencode",
  );
}

/** Absolute path of the script-downloaded `opencode` executable for a platform. */
export function openCodeManagedScriptBinaryPath(
  managedDir: string,
  platform: NodeJS.Platform,
): string {
  return NodePath.join(
    openCodeManagedScriptBinDir(managedDir),
    platform === "win32" ? "opencode.exe" : "opencode",
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
 * official script's `~/.opencode/bin`, then the T3-managed installs
 * (npm first, script-downloaded second).
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
    candidates.push(openCodeManagedScriptBinaryPath(managedDir, input.platform));
  }
  return candidates;
}

/**
 * npm package name for an install spec (`name@version`, scope-aware).
 * `opencode-ai@latest` → `opencode-ai`; `@opencode/cli@latest` → `@opencode/cli`.
 */
export function openCodeNpmPackageFromSpec(spec: string): string {
  const rest = spec.startsWith("@") ? spec.slice(1) : spec;
  const slash = rest.indexOf("/");
  const at = rest.lastIndexOf("@");
  if (spec.startsWith("@") && slash >= 0) {
    return `@${at > slash ? rest.slice(0, at) : rest}`;
  }
  return at > 0 ? rest.slice(0, at) : rest;
}

/** `npm install` argv that drops the CLI into the managed directory. */
export function openCodeNpmInstallArgs(
  managedDir: string,
  spec: string = OPENCODE_NPM_INSTALL_SPEC,
): ReadonlyArray<string> {
  const allowScriptsPackage = openCodeNpmPackageFromSpec(spec);
  return [
    "install",
    "--prefix",
    managedDir,
    // npm blocks install scripts by default while exiting 0; opencode-ai's
    // postinstall copies the platform binary into place, so without this the
    // install "succeeds" but leaves a broken binary (same reason the provider
    // update commands pass --allow-scripts).
    `--allow-scripts=${allowScriptsPackage}`,
    "--no-audit",
    "--no-fund",
    spec,
  ];
}

/** Minimal `package.json` so `npm --prefix` has a project to work in. */
export function openCodeManagedPackageJson(): string {
  return `${JSON.stringify(
    {
      name: "t3-managed-opencode",
      private: true,
      description: "Doer-managed OpenCode CLI install. Safe to delete; it reinstalls on demand.",
    },
    null,
    2,
  )}\n`;
}

/**
 * Release target triple, mirroring the supported combos of the official
 * install script (`os-arch`), with one deliberate exception: upstream ships
 * no Windows ARM64 asset, so Windows on ARM falls back to the x64 asset,
 * which Windows 11 runs under x64 emulation. `null` means neither the
 * script nor the fallback has an asset for this host — surface the manual
 * install instead.
 */
export type OpenCodeInstallTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "windows-x64";

export function openCodeInstallTargetForHost(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): OpenCodeInstallTarget | null {
  const normalizedArch =
    input.arch === "aarch64" ? "arm64" : input.arch === "x86_64" ? "x64" : input.arch;
  if (input.platform === "darwin" && (normalizedArch === "arm64" || normalizedArch === "x64")) {
    return `darwin-${normalizedArch}`;
  }
  if (input.platform === "linux" && (normalizedArch === "arm64" || normalizedArch === "x64")) {
    return `linux-${normalizedArch}`;
  }
  if (input.platform === "win32" && (normalizedArch === "x64" || normalizedArch === "arm64")) {
    return "windows-x64";
  }
  return null;
}

/** Release archive name for a target: `.zip` everywhere but Linux (`.tar.gz`). */
export function openCodeInstallArchiveFilename(target: OpenCodeInstallTarget): string {
  return `opencode-${target}${target.startsWith("linux-") ? ".tar.gz" : ".zip"}`;
}

/** Direct download URL for a target's release archive. */
export function openCodeInstallDownloadUrl(target: OpenCodeInstallTarget): string {
  return `${OPENCODE_RELEASE_DOWNLOAD_BASE_URL}/${openCodeInstallArchiveFilename(target)}`;
}

/** `curl` argv that downloads a URL to a file, failing loudly on HTTP errors. */
export function openCodeCurlDownloadArgs(url: string, outputPath: string): ReadonlyArray<string> {
  return ["-fsSL", "-L", "-o", outputPath, url];
}

export interface OpenCodeExtractCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Quote a path for PowerShell single-quoted string context. */
export function powershellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Extraction command for a downloaded archive. Linux uses `tar`, macOS
 * `unzip` (both ship with the OS), Windows uses PowerShell's built-in
 * `Expand-Archive` so no third-party tool is needed. `null` on platforms
 * without a known extractor.
 */
export function openCodeArchiveExtractCommand(input: {
  readonly platform: NodeJS.Platform;
  readonly archivePath: string;
  readonly destDir: string;
}): OpenCodeExtractCommand | null {
  if (input.platform === "linux") {
    return { command: "tar", args: ["-xzf", input.archivePath, "-C", input.destDir] };
  }
  if (input.platform === "darwin") {
    return { command: "unzip", args: ["-q", input.archivePath, "-d", input.destDir] };
  }
  if (input.platform === "win32") {
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath ${powershellSingleQuoted(input.archivePath)} -DestinationPath ${powershellSingleQuoted(input.destDir)} -Force`,
      ],
    };
  }
  return null;
}

/**
 * Binary file names to look for inside an extracted release archive, most
 * likely first. Release zips have shipped both layouts over time.
 */
export function openCodeExtractedBinaryNames(platform: NodeJS.Platform): ReadonlyArray<string> {
  return platform === "win32" ? ["opencode.exe", "opencode"] : ["opencode", "opencode.exe"];
}
