/**
 * Pinned install of the external tool computer use is built on.
 *
 * `open-computer-use` sees the desktop and operates real GUI apps through
 * Accessibility / UI Automation / AT-SPI. It is installed after the user
 * enables agent computer access into `<baseDir>/tools/<name>/<version>` and
 * executed from there with the server's own Node, never `npx`: an ephemeral
 * npx cache would make every first `computer_start` after a reboot depend on
 * the registry, and the pinned version is part of the contract the injected
 * agent instructions describe.
 *
 * The preferred path needs no system tools at all: the pinned tarball is
 * fetched with the server's own network stack and unpacked directly. This is
 * what makes computer use work on fresh Windows machines with no Node.js,
 * npm, or pnpm installed. `npm install` stays as a fallback for machines
 * whose proxy setup only npm understands.
 *
 * Install follows the pinned-runtime recipe: stage into a temp sibling, write
 * a sentinel only after the tree verifies, then rename into place. Package
 * managers extract files before they finish, so an entry file alone does not
 * prove a usable tree.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ProcessRunner from "../processRunner.ts";

const COMPUTER_USE_PACKAGE = "open-computer-use";
const COMPUTER_USE_VERSION = "0.3.5";

// Pinned tarball for the npm-free install path (`npm view
// open-computer-use@0.3.5 dist.tarball` / `dist.integrity`). The package has
// no runtime dependencies, so extracting this one archive is a complete
// install — no dependency resolution needed.
const COMPUTER_USE_TARBALL_URL =
  "https://registry.npmjs.org/open-computer-use/-/open-computer-use-0.3.5.tgz";
const COMPUTER_USE_TARBALL_SHA512_B64 =
  "KKRY42by3yR+XPJiu6tk9wCn6lp0Y/dh1i8ap2SpW45hNSTej/hTPy1uquOLn/E4wF9hvPgProxmrsNj2FdpjQ==";

const INSTALL_TIMEOUT = Duration.minutes(10);
const installLock = Semaphore.makeUnsafe(1);

// The tarball is ~6 MB / ~13 MB unpacked; these bounds only catch corruption
// or a compromised registry response, never a legitimate release.
const TARBALL_DOWNLOAD_LIMIT_BYTES = 32 * 1024 * 1024;
const TARBALL_EXTRACT_LIMIT_BYTES = 256 * 1024 * 1024;
const TARBALL_ENTRY_LIMIT = 10_000;
const TARBALL_FILE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface ComputerToolPaths {
  readonly installDir: string;
  /** Absolute path of the `ocu` launcher, run with the server's Node. */
  readonly entryPath: string;
  readonly sentinelPath: string;
}

export class ComputerToolchainInstallError extends Schema.TaggedError<ComputerToolchainInstallError>()(
  "ComputerToolchainInstallError",
  {
    tool: Schema.String,
    step: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const suffix = this.exitCode === undefined ? "" : ` (exit code ${this.exitCode})`;
    return `Installing ${this.tool} failed while ${this.step}${suffix}.`;
  }
}

const toolPaths = (path: Path.Path, baseDir: string): ComputerToolPaths => {
  const installDir = path.join(baseDir, "tools", COMPUTER_USE_PACKAGE, COMPUTER_USE_VERSION);
  return {
    installDir,
    entryPath: computerUseEntryPath(path, baseDir),
    sentinelPath: path.join(installDir, ".install-complete"),
  };
};

/** Absolute path of the `ocu` launcher inside a completed install. */
export const computerUseEntryPath = (path: Path.Path, baseDir: string): string =>
  path.join(
    baseDir,
    "tools",
    COMPUTER_USE_PACKAGE,
    COMPUTER_USE_VERSION,
    "node_modules",
    COMPUTER_USE_PACKAGE,
    "bin",
    "ocu",
  );

interface TarEntry {
  /** Archive-relative posix path, e.g. `package/bin/ocu`. */
  readonly name: string;
  readonly type: "file" | "directory";
  readonly mode: number;
  readonly data: Uint8Array;
}

const readCString = (bytes: Uint8Array, start: number, length: number): string => {
  const slice = bytes.subarray(start, start + length);
  const nul = slice.indexOf(0);
  const text = new TextDecoder().decode(nul === -1 ? slice : slice.subarray(0, nul));
  return text.replace(/[\0 ]+$/u, "");
};

const parseOctalField = (field: string): number | undefined => {
  const trimmed = field.trim();
  if (trimmed.length === 0 || !/^[0-7]+$/u.test(trimmed)) return undefined;
  const value = Number.parseInt(trimmed, 8);
  return Number.isSafeInteger(value) ? value : undefined;
};

/**
 * Minimal tar reader for npm registry tarballs: regular files, directories,
 * GNU longnames, and pax `path=` overrides. Everything else (symlinks,
 * hardlinks, devices) is skipped — the pinned package ships none of those.
 * Throws on truncation or corruption; the caller falls back to `npm install`.
 */
export function parseTarArchive(input: Uint8Array): ReadonlyArray<TarEntry> {
  const entries: Array<TarEntry> = [];
  let offset = 0;
  let pendingLongName: string | undefined;
  let pendingPathOverride: string | undefined;

  const fail = (message: string): never => {
    throw new Error(`Invalid helper archive: ${message}`);
  };

  while (true) {
    if (offset >= input.length) break;
    if (offset + 512 > input.length) {
      if (input.subarray(offset).every((byte) => byte === 0)) break;
      fail("truncated header");
    }
    const header = input.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;
    if (entries.length >= TARBALL_ENTRY_LIMIT) fail("too many entries");

    const nameField = readCString(header, 0, 100);
    const mode = parseOctalField(readCString(header, 100, 8)) ?? 0o644;
    const size = parseOctalField(readCString(header, 124, 12)) ?? fail("unreadable entry size");
    const typeflag = String.fromCharCode(header[156]!);
    const prefix = readCString(header, 345, 155);

    // Header checksum: the checksum field itself counts as spaces.
    const storedChecksum = parseOctalField(readCString(header, 148, 8));
    let computedChecksum = 8 * 32;
    for (let i = 0; i < 512; i++) {
      if (i < 148 || i >= 156) computedChecksum += header[i]!;
    }
    if (storedChecksum !== computedChecksum) fail("corrupt header checksum");

    const dataEnd = offset + size;
    if (dataEnd > input.length) fail("truncated entry data");
    const data = input.subarray(offset, dataEnd);
    offset += Math.ceil(size / 512) * 512;

    if (typeflag === "L") {
      pendingLongName = new TextDecoder().decode(data).replace(/\0+$/u, "");
      continue;
    }
    if (typeflag === "K") continue;
    if (typeflag === "x") {
      // Pax extended header: `"<len> path=<override>\n"` records.
      for (const line of new TextDecoder().decode(data).split("\n")) {
        const match = /^[0-9]+ path=(.*)$/u.exec(line);
        if (match?.[1]) pendingPathOverride = match[1];
      }
      continue;
    }
    if (typeflag === "g") continue;

    const rawName =
      pendingLongName ?? pendingPathOverride ?? (prefix ? `${prefix}/${nameField}` : nameField);
    pendingLongName = undefined;
    pendingPathOverride = undefined;

    if (typeflag === "5") {
      entries.push({ name: rawName, type: "directory", mode, data: new Uint8Array(0) });
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0") continue;
    entries.push({ name: rawName, type: "file", mode, data });
  }
  return entries;
}

/**
 * Maps an archive path to the segments below
 * `node_modules/open-computer-use/`, or `undefined` to skip the entry.
 * Skipping (rather than failing) keeps one oddball entry from breaking the
 * install; the staged entry-point check still guarantees a usable tree.
 */
export function tarEntryTargetSegments(name: string): ReadonlyArray<string> | undefined {
  const withoutTrailingSlash = name.endsWith("/") ? name.slice(0, -1) : name;
  if (!withoutTrailingSlash.startsWith("package/")) return undefined;
  const remainder = withoutTrailingSlash.slice("package/".length);
  if (remainder.length === 0) return undefined;
  const segments = remainder.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") return undefined;
    if (segment.includes("\\") || segment.includes(":")) return undefined;
  }
  return segments;
}

const isInstalled = Effect.fn("ComputerToolchain.isInstalled")(function* (
  fs: FileSystem.FileSystem,
  paths: ComputerToolPaths,
) {
  const [entryExists, sentinel] = yield* Effect.all([
    fs.exists(paths.entryPath),
    fs.readFileString(paths.sentinelPath).pipe(Effect.option),
  ]).pipe(Effect.orElseSucceed(() => [false, Option.none<string>()] as const));
  return entryExists && Option.isSome(sentinel) && sentinel.value.trim() === COMPUTER_USE_VERSION;
});

/**
 * Tarball source for the npm-free install path. Production downloads the
 * pinned registry tarball; tests inject a stub. An `Effect.succeed` stub
 * (no requirements) fits wherever this type is expected.
 */
export type ComputerUseTarballFetcher = Effect.Effect<
  Uint8Array,
  ComputerToolchainInstallError,
  HttpClient.HttpClient
>;

const downloadPinnedTarball: ComputerUseTarballFetcher = Effect.gen(function* () {
  const fail = (step: string) => (cause: unknown) =>
    new ComputerToolchainInstallError({ tool: COMPUTER_USE_PACKAGE, step, cause });
  const http = yield* HttpClient.HttpClient;
  const response = yield* http
    .execute(HttpClientRequest.get(COMPUTER_USE_TARBALL_URL))
    .pipe(Effect.mapError(fail("downloading the helper")), Effect.scoped);
  if (response.status !== 200) {
    return yield* new ComputerToolchainInstallError({
      tool: COMPUTER_USE_PACKAGE,
      step: "downloading the helper",
      cause: `Registry responded with HTTP ${response.status}`,
    });
  }
  const contentLength = response.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > TARBALL_DOWNLOAD_LIMIT_BYTES) {
    return yield* new ComputerToolchainInstallError({
      tool: COMPUTER_USE_PACKAGE,
      step: "downloading the helper",
      cause: "Registry response exceeds the download size limit",
    });
  }
  const bytes = yield* response.arrayBuffer.pipe(
    Effect.mapError(fail("downloading the helper")),
    Effect.map((buffer) => new Uint8Array(buffer)),
  );
  if (bytes.length > TARBALL_DOWNLOAD_LIMIT_BYTES) {
    return yield* new ComputerToolchainInstallError({
      tool: COMPUTER_USE_PACKAGE,
      step: "downloading the helper",
      cause: "Downloaded archive exceeds the download size limit",
    });
  }
  const digest = NodeCrypto.createHash("sha512").update(bytes).digest("base64");
  if (digest !== COMPUTER_USE_TARBALL_SHA512_B64) {
    return yield* new ComputerToolchainInstallError({
      tool: COMPUTER_USE_PACKAGE,
      step: "downloading the helper",
      cause: "Downloaded archive failed its integrity check",
    });
  }
  return bytes;
});

const writeTarballTree = Effect.fn("ComputerToolchain.writeTarballTree")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  platform: NodeJS.Platform,
  stagingDir: string,
  entries: ReadonlyArray<TarEntry>,
) {
  const fail = (step: string) => (cause: unknown) =>
    new ComputerToolchainInstallError({ tool: COMPUTER_USE_PACKAGE, step, cause });
  const base = path.join(stagingDir, "node_modules", COMPUTER_USE_PACKAGE);
  yield* fs
    .makeDirectory(base, { recursive: true })
    .pipe(Effect.mapError(fail("unpacking the helper")));
  let totalBytes = 0;
  for (const entry of entries) {
    const segments = tarEntryTargetSegments(entry.name);
    if (segments === undefined) continue;
    const target = path.join(base, ...segments);
    if (entry.type === "directory") {
      yield* fs
        .makeDirectory(target, { recursive: true })
        .pipe(Effect.mapError(fail("unpacking the helper")));
      continue;
    }
    totalBytes += entry.data.length;
    if (entry.data.length > TARBALL_FILE_LIMIT_BYTES || totalBytes > TARBALL_EXTRACT_LIMIT_BYTES) {
      return yield* new ComputerToolchainInstallError({
        tool: COMPUTER_USE_PACKAGE,
        step: "unpacking the helper",
        cause: "Extracted contents exceed the unpack size limit",
      });
    }
    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.mapError(fail("unpacking the helper")));
    yield* fs.writeFile(target, entry.data).pipe(Effect.mapError(fail("unpacking the helper")));
    // The native runtimes are spawned directly, so they need the exec bit
    // npm would have restored. The `ocu` launcher itself runs through the
    // server's Node and needs no exec bit. chmod is a no-op on Windows.
    if ((entry.mode & 0b001_001_001) !== 0 && platform !== "win32") {
      yield* fs.chmod(target, 0o755).pipe(Effect.mapError(fail("unpacking the helper")));
    }
  }
});

/**
 * Preferred install path: fetch the pinned tarball with the server's own
 * network stack and unpack it directly. Needs no npm, pnpm, tar, or shell —
 * nothing a fresh Windows machine lacks.
 */
const installViaTarball = Effect.fn("ComputerToolchain.installViaTarball")(function* (
  stagingDir: string,
  fetcher: ComputerUseTarballFetcher,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;

  const compressed = yield* fetcher.pipe(
    Effect.timeout(INSTALL_TIMEOUT),
    Effect.catchTag("TimeoutError", (cause) =>
      Effect.fail(
        new ComputerToolchainInstallError({
          tool: COMPUTER_USE_PACKAGE,
          step: "downloading the helper",
          cause,
        }),
      ),
    ),
  );
  const tarBytes = yield* Effect.try({
    try: () => NodeZlib.gunzipSync(compressed),
    catch: (cause) =>
      new ComputerToolchainInstallError({
        tool: COMPUTER_USE_PACKAGE,
        step: "unpacking the helper",
        cause,
      }),
  }).pipe(Effect.map((output) => new Uint8Array(output)));
  // parseTarArchive only throws plain Errors, so every failure here wraps
  // the same way.
  const entries = yield* Effect.try({
    try: () => parseTarArchive(tarBytes),
    catch: (cause) =>
      new ComputerToolchainInstallError({
        tool: COMPUTER_USE_PACKAGE,
        step: "unpacking the helper",
        cause,
      }),
  });
  yield* writeTarballTree(fs, path, platform, stagingDir, entries);
});

const runNpmInstall = Effect.fn("ComputerToolchain.runNpmInstall")(function* (stagingDir: string) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fail = (step: string) => (cause: unknown) =>
    new ComputerToolchainInstallError({ tool: COMPUTER_USE_PACKAGE, step, cause });
  const installArgs = [
    "install",
    "--prefix",
    stagingDir,
    "--no-fund",
    "--no-audit",
    `${COMPUTER_USE_PACKAGE}@${COMPUTER_USE_VERSION}`,
  ];
  const result = yield* runner
    .run({ command: "npm", args: installArgs, timeout: INSTALL_TIMEOUT })
    .pipe(
      Effect.catchTags({
        ProcessSpawnError: (error) =>
          error.cause instanceof PlatformError.PlatformError &&
          error.cause.reason._tag === "NotFound"
            ? runner.run({
                command: "pnpm",
                args: ["--package=npm@11", "dlx", "npm", ...installArgs],
                timeout: INSTALL_TIMEOUT,
              })
            : Effect.fail(error),
      }),
      Effect.mapError(fail("running npm install")),
    );
  if (result.code !== 0) {
    return yield* new ComputerToolchainInstallError({
      tool: COMPUTER_USE_PACKAGE,
      step: "running npm install",
      exitCode: Number(result.code),
      cause: result,
    });
  }
});

const publishStagedInstall = Effect.fn("ComputerToolchain.publishStagedInstall")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  paths: ComputerToolPaths,
  stagingDir: string,
) {
  const fail = (step: string) => (cause: unknown) =>
    new ComputerToolchainInstallError({ tool: COMPUTER_USE_PACKAGE, step, cause });
  const stagedEntry = path.join(stagingDir, "node_modules", COMPUTER_USE_PACKAGE, "bin", "ocu");
  if (!(yield* fs.exists(stagedEntry).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new ComputerToolchainInstallError({
      tool: COMPUTER_USE_PACKAGE,
      step: "verifying the installed entry point",
    });
  }
  yield* fs
    .writeFileString(path.join(stagingDir, ".install-complete"), `${COMPUTER_USE_VERSION}\n`)
    .pipe(Effect.mapError(fail("recording the completed install")));
  yield* fs.rename(stagingDir, paths.installDir).pipe(
    Effect.catch((cause) =>
      // A concurrent server may have published the same version first.
      isInstalled(fs, paths).pipe(
        Effect.flatMap((published) =>
          published ? Effect.void : Effect.fail(fail("publishing the install")(cause)),
        ),
      ),
    ),
  );
  return paths;
});

const installTool = Effect.fn("ComputerToolchain.installTool")(function* (
  paths: ComputerToolPaths,
  fetcher: ComputerUseTarballFetcher = downloadPinnedTarball,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (step: string) => (cause: unknown) =>
    new ComputerToolchainInstallError({ tool: COMPUTER_USE_PACKAGE, step, cause });

  if (yield* isInstalled(fs, paths)) return paths;

  const parentDir = path.dirname(paths.installDir);
  yield* fs
    .remove(paths.installDir, { recursive: true, force: true })
    .pipe(Effect.mapError(fail("removing an incomplete install")));
  yield* fs
    .makeDirectory(parentDir, { recursive: true })
    .pipe(Effect.mapError(fail("preparing the install directory")));
  const stagingDir = yield* fs
    .makeTempDirectory({ directory: parentDir, prefix: ".staging-" })
    .pipe(Effect.mapError(fail("preparing the install directory")));

  return yield* Effect.gen(function* () {
    const tarballFailure = yield* installViaTarball(stagingDir, fetcher).pipe(
      Effect.as(Option.none<ComputerToolchainInstallError>()),
      Effect.catch((error) =>
        Effect.as(
          // The bundled fetch honors fewer proxy setups than npm, so a
          // corporate proxy can break the direct download while npm works.
          Effect.logWarning(
            "Direct computer-use helper download failed; falling back to npm install.",
            { cause: error },
          ),
          Option.some(error),
        ),
      ),
    );
    if (Option.isNone(tarballFailure)) {
      return yield* publishStagedInstall(fs, path, paths, stagingDir);
    }
    const npmFailure = yield* runNpmInstall(stagingDir).pipe(
      Effect.as(Option.none<ComputerToolchainInstallError>()),
      Effect.catch((error) => Effect.succeed(Option.some(error))),
    );
    if (Option.isNone(npmFailure)) {
      return yield* publishStagedInstall(fs, path, paths, stagingDir);
    }
    const npmError = npmFailure.value;
    const npmMissing = npmError.step === "running npm install" && npmError.exitCode === undefined;
    // Fresh machines have neither network luck nor npm: report the download
    // failure (actionable: check the connection) instead of npm internals.
    if (npmMissing) {
      return yield* new ComputerToolchainInstallError({
        tool: COMPUTER_USE_PACKAGE,
        step: "downloading the helper automatically",
        cause: tarballFailure.value,
      });
    }
    return yield* npmError;
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensureComputerUse = Effect.fn("ComputerToolchain.ensure")(function* (
  baseDir: string,
  fetcher?: ComputerUseTarballFetcher | undefined,
) {
  const path = yield* Path.Path;
  const paths = toolPaths(path, baseDir);
  return yield* installLock.withPermit(
    fetcher === undefined ? installTool(paths) : installTool(paths, fetcher),
  );
});

export const isComputerUseInstalled = Effect.fn("ComputerToolchain.isInstalled")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* isInstalled(fs, toolPaths(path, baseDir));
});
