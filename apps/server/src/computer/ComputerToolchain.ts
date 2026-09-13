/**
 * Pinned install of the external tool computer use is built on.
 *
 * `open-computer-use` sees the desktop and operates real GUI apps through
 * Accessibility / UI Automation / AT-SPI. It is npm-installed after the user
 * enables agent computer access into `<baseDir>/tools/<name>/<version>` and
 * executed from there with the server's own Node, never `npx`: an ephemeral
 * npx cache would make every first `computer_start` after a reboot depend on
 * the registry, and the pinned version is part of the contract the injected
 * agent instructions describe.
 *
 * Install follows the pinned-runtime recipe: stage into a temp sibling, write
 * a sentinel only after npm exits 0, then rename into place. npm extracts
 * files before it finishes, so an entry file alone does not prove a usable
 * tree.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

const COMPUTER_USE_PACKAGE = "open-computer-use";
const COMPUTER_USE_VERSION = "0.3.5";

const INSTALL_TIMEOUT = Duration.minutes(10);
const installLock = Semaphore.makeUnsafe(1);

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

const installTool = Effect.fn("ComputerToolchain.installTool")(function* (
  paths: ComputerToolPaths,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
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
  }).pipe(
    Effect.ensuring(fs.remove(stagingDir, { recursive: true, force: true }).pipe(Effect.ignore)),
  );
});

export const ensureComputerUse = Effect.fn("ComputerToolchain.ensure")(function* (baseDir: string) {
  const path = yield* Path.Path;
  const paths = toolPaths(path, baseDir);
  return yield* installLock.withPermit(installTool(paths));
});

export const isComputerUseInstalled = Effect.fn("ComputerToolchain.isInstalled")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* isInstalled(fs, toolPaths(path, baseDir));
});
