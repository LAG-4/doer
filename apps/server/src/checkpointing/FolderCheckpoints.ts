import { VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as NativeFolderCheckpoints from "./NativeFolderCheckpoints.ts";
import * as LegacyFolderCheckpoints from "./LegacyFolderCheckpoints.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";

/** New folder History is Git-free; existing private Git histories remain readable when Git is available. */
export const make = (stateDir: string) =>
  Effect.gen(function* () {
    const native = yield* NativeFolderCheckpoints.make(stateDir);
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const process = yield* Effect.serviceOption(VcsProcess);
    const legacy = Option.isSome(process)
      ? yield* LegacyFolderCheckpoints.make(stateDir).pipe(
          Effect.provideService(VcsProcess, process.value),
        )
      : null;
    const resolve = (cwd: string) =>
      Effect.gen(function* () {
        const directory = yield* native.storageDirectory(cwd);
        if (
          !legacy ||
          !(yield* fs.exists(path.join(directory, "HEAD"))) ||
          (yield* fs.exists(path.join(directory, "snapshots")))
        )
          return native;
        const gitAvailable =
          Option.isSome(process) &&
          (yield* process.value
            .run({ operation: "FolderHistory.legacy", command: "git", args: ["--version"], cwd })
            .pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            ));
        return gitAvailable ? legacy : native;
      }).pipe(
        Effect.mapError((cause) =>
          cause._tag === "PlatformError"
            ? new VcsProcessExitError({
                operation: "FolderHistory.resolve",
                command: "filesystem",
                cwd,
                exitCode: 1,
                detail: cause.message,
              })
            : cause,
        ),
      );
    return {
      captureCheckpoint: (input) =>
        resolve(input.cwd).pipe(Effect.flatMap((history) => history.captureCheckpoint(input))),
      hasCheckpointRef: (input) =>
        resolve(input.cwd).pipe(Effect.flatMap((history) => history.hasCheckpointRef(input))),
      restoreCheckpoint: (input) =>
        resolve(input.cwd).pipe(Effect.flatMap((history) => history.restoreCheckpoint(input))),
      diffCheckpoints: (input) =>
        resolve(input.cwd).pipe(Effect.flatMap((history) => history.diffCheckpoints(input))),
      deleteCheckpointRefs: (input) =>
        resolve(input.cwd).pipe(Effect.flatMap((history) => history.deleteCheckpointRefs(input))),
    } satisfies VcsCheckpointOps;
  });
