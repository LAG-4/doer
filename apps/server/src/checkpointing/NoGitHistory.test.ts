import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointRef, VcsProcessSpawnError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";

const noGit = Layer.mock(VcsProcess)({
  run: (input) =>
    Effect.fail(
      new VcsProcessSpawnError({
        operation: input.operation,
        command: input.command,
        cwd: input.cwd,
        cause: new Error("ENOENT: git is not installed"),
      }),
    ),
});
const config = ServerConfig.layerTest(process.cwd(), { prefix: "doer-no-git-" });
const registry = VcsDriverRegistry.layer.pipe(Layer.provide(noGit));
const testLayer = CheckpointStore.layer.pipe(
  Layer.provideMerge(registry),
  Layer.provideMerge(noGit),
  Layer.provide(config),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(testLayer)("History without Git installed", (it) => {
  it.effect("captures folder changes, reports diffs and safely undoes only this Task's files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const history = yield* CheckpointStore.CheckpointStore;
      const root = yield* fs.makeTempDirectoryScoped();
      const before = CheckpointRef.make("refs/doer/no-git/before");
      const after = CheckpointRef.make("refs/doer/no-git/after");
      yield* fs.writeFileString(`${root}/document.txt`, "original\n");
      yield* fs.writeFileString(`${root}/sibling.txt`, "other Task\n");
      yield* fs.writeFileString(`${root}/.gitignore`, "private/\n");
      yield* fs.makeDirectory(`${root}/private`);
      yield* fs.writeFileString(`${root}/private/keep.txt`, "ignored\n");
      assert.isFalse(yield* history.isGitRepository(root));
      yield* history.captureCheckpoint({ cwd: root, checkpointRef: before });
      yield* fs.writeFileString(`${root}/document.txt`, "edited\n");
      yield* fs.writeFile(`${root}/report.xlsx`, new Uint8Array([0, 255, 12]));
      yield* history.captureCheckpoint({ cwd: root, checkpointRef: after });
      const diff = yield* history.diffCheckpoints({
        cwd: root,
        fromCheckpointRef: before,
        toCheckpointRef: after,
        ignoreWhitespace: false,
        format: "numstat",
      });
      assert.deepEqual(
        parseTurnDiffFilesFromNumstat(diff)
          .map((file) => file.path)
          .sort(),
        ["document.txt", "report.xlsx"],
      );
      yield* fs.writeFileString(`${root}/sibling.txt`, "newer work\n");
      yield* fs.writeFileString(`${root}/private/keep.txt`, "newer ignored\n");
      assert.isTrue(
        yield* history.restoreCheckpoint({
          cwd: root,
          checkpointRef: before,
          expectedPaths: [
            { path: "document.txt", checkpointRef: after },
            { path: "report.xlsx", checkpointRef: after },
          ],
        }),
      );
      assert.equal(yield* fs.readFileString(`${root}/document.txt`), "original\n");
      assert.isFalse(yield* fs.exists(`${root}/report.xlsx`));
      assert.equal(yield* fs.readFileString(`${root}/sibling.txt`), "newer work\n");
      assert.equal(yield* fs.readFileString(`${root}/private/keep.txt`), "newer ignored\n");
      assert.isFalse(yield* fs.exists(`${root}/.git`));
    }),
  );
  it.effect("refuses to follow links while undoing and keeps nested ignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const history = yield* CheckpointStore.CheckpointStore;
      const root = yield* fs.makeTempDirectoryScoped();
      const outside = yield* fs.makeTempDirectoryScoped();
      const before = CheckpointRef.make("refs/doer/links/before");
      const after = CheckpointRef.make("refs/doer/links/after");
      yield* fs.makeDirectory(`${root}/nested/private`, { recursive: true });
      yield* fs.writeFileString(`${root}/nested/.gitignore`, "private/\n");
      yield* fs.writeFileString(`${root}/nested/private/file.txt`, "ignored");
      yield* fs.writeFileString(`${root}/own.txt`, "before");
      yield* history.captureCheckpoint({ cwd: root, checkpointRef: before });
      yield* fs.writeFileString(`${root}/own.txt`, "after");
      yield* fs.writeFileString(`${root}/nested/private/file.txt`, "new ignored content");
      yield* history.captureCheckpoint({ cwd: root, checkpointRef: after });
      const diff = yield* history.diffCheckpoints({
        cwd: root,
        fromCheckpointRef: before,
        toCheckpointRef: after,
        ignoreWhitespace: false,
        format: "numstat",
      });
      assert.deepEqual(
        parseTurnDiffFilesFromNumstat(diff).map((file) => file.path),
        ["own.txt"],
      );
      yield* fs.writeFileString(`${outside}/keep.txt`, "outside data");
      yield* fs.remove(`${root}/own.txt`);
      yield* fs.symlink(`${outside}/keep.txt`, `${root}/own.txt`);
      const failure = yield* Effect.flip(
        history.restoreCheckpoint({
          cwd: root,
          checkpointRef: before,
          expectedPaths: [{ path: "own.txt", checkpointRef: after }],
        }),
      );
      assert.include(failure.message, "changed after this Task");
      assert.equal(yield* fs.readFileString(`${outside}/keep.txt`), "outside data");
      assert.equal(
        yield* fs.readFileString(`${root}/nested/private/file.txt`),
        "new ignored content",
      );
    }),
  );
});
