import * as NodeCrypto from "node:crypto";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";

/** File History for ordinary folders. The private index never changes the user's folder into a repository. */
export const make = (stateDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* VcsProcess;
    const gates = new Map<string, Semaphore.Semaphore>();
    const git = Effect.fn("FolderCheckpoints.git")(
      function* (cwd: string, args: readonly string[], stdin?: string) {
        const real = yield* fs.realPath(cwd).pipe(
          Effect.mapError(
            (cause) =>
              new VcsProcessExitError({
                operation: "FolderCheckpoints.git",
                command: "git",
                cwd,
                exitCode: 1,
                detail: cause.message,
              }),
          ),
        );
        const id = NodeCrypto.createHash("sha256").update(real).digest("hex");
        const directory = path.join(stateDir, "folder-history", id);
        const env = Object.fromEntries(
          Object.entries(globalThis.process.env).filter(([key]) => !key.startsWith("GIT_")),
        );
        const run = (commandArgs: readonly string[], input?: string) =>
          process.run({
            operation: "FolderCheckpoints.git",
            command: "git",
            cwd: real,
            args: commandArgs,
            env: {
              ...env,
              GIT_AUTHOR_NAME: "Doer",
              GIT_AUTHOR_EMAIL: "history@doer.local",
              GIT_COMMITTER_NAME: "Doer",
              GIT_COMMITTER_EMAIL: "history@doer.local",
            },
            ...(input !== undefined ? { stdin: input } : {}),
            timeoutMs: 30_000,
            maxOutputBytes: 8_000_000,
          });
        if (!(yield* fs.exists(path.join(directory, "HEAD")))) {
          yield* fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.mapError(
              (cause) =>
                new VcsProcessExitError({
                  operation: "FolderCheckpoints.git",
                  command: "git",
                  cwd,
                  exitCode: 1,
                  detail: cause.message,
                }),
            ),
          );
          yield* run(["init", "--bare", directory]);
          // Ignore disposable dependencies, tool state and common caches, never personal documents.
          yield* fs
            .writeFileString(
              path.join(directory, "info", "exclude"),
              "node_modules/\n.git/\n.t3/\n.cache/\n__pycache__/\n.DS_Store\n",
            )
            .pipe(
              Effect.mapError(
                (cause) =>
                  new VcsProcessExitError({
                    operation: "FolderCheckpoints.git",
                    command: "git",
                    cwd,
                    exitCode: 1,
                    detail: cause.message,
                  }),
              ),
            );
        }
        return yield* run(
          [
            "--literal-pathspecs",
            "--git-dir",
            directory,
            "--work-tree",
            real,
            "-c",
            "core.bare=false",
            "-c",
            "core.fsmonitor=false",
            ...args,
          ],
          stdin,
        );
      },
      Effect.mapError((cause) =>
        cause._tag === "PlatformError"
          ? new VcsProcessExitError({
              operation: "FolderCheckpoints.git",
              command: "git",
              cwd: "",
              exitCode: 1,
              detail: cause.message,
            })
          : cause,
      ),
    );
    const locked = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) => {
      return fs.realPath(cwd).pipe(
        Effect.mapError(
          (cause) =>
            new VcsProcessExitError({
              operation: "FolderCheckpoints.lock",
              command: "git",
              cwd,
              exitCode: 1,
              detail: cause.message,
            }),
        ),
        Effect.flatMap((real) => {
          let gate = gates.get(real);
          if (!gate) {
            gate = Semaphore.makeUnsafe(1);
            gates.set(real, gate);
          }
          return gate.withPermit(effect);
        }),
      );
    };
    const hasRef = Effect.fn("FolderCheckpoints.hasRef")(function* (cwd: string, ref: string) {
      const result = yield* git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).pipe(
        Effect.catch((error) =>
          error._tag === "VcsProcessExitError" && error.exitCode === 1
            ? Effect.succeed(null)
            : Effect.fail(error),
        ),
      );
      return result !== null;
    });
    const ops: VcsCheckpointOps = {
      captureCheckpoint: (input) =>
        locked(
          input.cwd,
          Effect.gen(function* () {
            yield* git(input.cwd, ["add", "-A", "--", "."]);
            const tree = (yield* git(input.cwd, ["write-tree"])).stdout.trim();
            const commit = (yield* git(
              input.cwd,
              ["commit-tree", tree],
              "Doer file History\n",
            )).stdout.trim();
            yield* git(input.cwd, ["update-ref", input.checkpointRef, commit]);
          }),
        ),
      hasCheckpointRef: (input) => locked(input.cwd, hasRef(input.cwd, input.checkpointRef)),
      restoreCheckpoint: (input) =>
        locked(
          input.cwd,
          Effect.gen(function* () {
            if (!(yield* hasRef(input.cwd, input.checkpointRef))) return false;
            // Stage the current covered files so restore also removes files created since the checkpoint.
            // Ignored files and folders are left alone; no broad clean is used.
            yield* git(input.cwd, ["add", "-A", "--", "."]);
            if (input.expectedPaths) {
              const currentTree = (yield* git(input.cwd, ["write-tree"])).stdout.trim();
              const groups = new Map<string, string[]>();
              for (const entry of input.expectedPaths) {
                const paths = groups.get(entry.checkpointRef) ?? [];
                paths.push(entry.path);
                groups.set(entry.checkpointRef, paths);
              }
              for (const [expected, paths] of groups) {
                const conflicts = (yield* git(input.cwd, [
                  "diff",
                  "--name-only",
                  "-z",
                  expected,
                  currentTree,
                  "--",
                  ...paths,
                ])).stdout;
                if (conflicts)
                  return yield* new VcsProcessExitError({
                    operation: "FolderCheckpoints.restore",
                    command: "git",
                    cwd: input.cwd,
                    exitCode: 1,
                    detail:
                      "Some files changed after this Task finished. They have been kept. Save a copy or undo the conversation without restoring files.",
                  });
              }
            }
            const covered = new Set(input.expectedPaths?.map((entry) => entry.path));
            const allFiles = (yield* git(input.cwd, [
              "ls-files",
              "--cached",
              `--with-tree=${input.checkpointRef}`,
              "-z",
            ])).stdout;
            const files = input.expectedPaths
              ? allFiles
                  .split("\0")
                  .filter((file) => covered.has(file))
                  .map((file) => `${file}\0`)
                  .join("")
              : allFiles;
            if (files)
              yield* git(
                input.cwd,
                [
                  "restore",
                  "--source",
                  input.checkpointRef,
                  "--worktree",
                  "--staged",
                  "--pathspec-from-file=-",
                  "--pathspec-file-nul",
                ],
                files,
              );
            return true;
          }),
        ),
      diffCheckpoints: (input) =>
        locked(
          input.cwd,
          Effect.gen(function* () {
            const result = yield* git(input.cwd, [
              "diff",
              ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
              ...(input.format === "numstat" ? ["--numstat", "-z"] : ["--binary"]),
              input.fromCheckpointRef,
              input.toCheckpointRef,
              "--",
              ".",
            ]);
            return result.stdout;
          }),
        ),
      deleteCheckpointRefs: (input) =>
        locked(
          input.cwd,
          Effect.forEach(input.checkpointRefs, (ref) => git(input.cwd, ["update-ref", "-d", ref]), {
            discard: true,
          }),
        ),
    };
    return ops;
  });
