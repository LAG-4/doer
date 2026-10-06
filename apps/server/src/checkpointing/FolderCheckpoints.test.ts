import { CheckpointRef } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import * as FolderCheckpoints from "./FolderCheckpoints.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
const TestLayer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));
it.layer(TestLayer)("ordinary folder History", (it) => {
  it.effect(
    "restores edits, removed files and binary files without changing ignored files or adding .git",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const state = yield* fs.makeTempDirectoryScoped();
        const history = yield* FolderCheckpoints.make(state);
        yield* fs.writeFileString(`${root}/notes with spaces.txt`, "original");
        yield* fs.writeFile(`${root}/report.xlsx`, new Uint8Array([0, 255, 17, 80]));
        yield* fs.makeDirectory(`${root}/node_modules`);
        yield* fs.writeFileString(`${root}/node_modules/keep.txt`, "cache");
        yield* history.captureCheckpoint({
          cwd: root,
          checkpointRef: CheckpointRef.make("refs/doer/before"),
        });
        yield* fs.writeFileString(`${root}/notes with spaces.txt`, "edited");
        yield* fs.remove(`${root}/report.xlsx`);
        yield* fs.writeFileString(`${root}/new.txt`, "new");
        yield* fs.writeFileString(`${root}/node_modules/keep.txt`, "new cache");
        yield* history.captureCheckpoint({
          cwd: root,
          checkpointRef: CheckpointRef.make("refs/doer/after"),
        });
        expect(
          yield* history.diffCheckpoints({
            cwd: root,
            fromCheckpointRef: CheckpointRef.make("refs/doer/before"),
            toCheckpointRef: CheckpointRef.make("refs/doer/after"),
            ignoreWhitespace: false,
            format: "numstat",
          }),
        ).toContain("notes with spaces.txt");
        expect(
          yield* history.restoreCheckpoint({
            cwd: root,
            checkpointRef: CheckpointRef.make("refs/doer/before"),
          }),
        ).toBe(true);
        expect(yield* fs.readFileString(`${root}/notes with spaces.txt`)).toBe("original");
        expect(Array.from(yield* fs.readFile(`${root}/report.xlsx`))).toEqual([0, 255, 17, 80]);
        expect(yield* fs.exists(`${root}/new.txt`)).toBe(false);
        expect(yield* fs.readFileString(`${root}/node_modules/keep.txt`)).toBe("new cache");
        expect(yield* fs.exists(`${root}/.git`)).toBe(false);
        expect(
          yield* history.restoreCheckpoint({
            cwd: root,
            checkpointRef: CheckpointRef.make("refs/doer/after"),
          }),
        ).toBe(true);
        expect(yield* fs.readFileString(`${root}/new.txt`)).toBe("new");
      }),
  );
  it.effect(
    "scopes undo to covered Task files and rejects later edits without changing anything",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const state = yield* fs.makeTempDirectoryScoped();
        const history = yield* FolderCheckpoints.make(state);
        const before = CheckpointRef.make("refs/doer/before");
        const after = CheckpointRef.make("refs/doer/after");
        yield* fs.writeFileString(`${root}/own.txt`, "before");
        yield* fs.writeFileString(`${root}/sibling.txt`, "other work");
        yield* history.captureCheckpoint({ cwd: root, checkpointRef: before });
        yield* fs.writeFileString(`${root}/own.txt`, "after");
        yield* history.captureCheckpoint({ cwd: root, checkpointRef: after });
        yield* fs.writeFileString(`${root}/sibling.txt`, "later sibling work");
        const expectedPaths = [{ path: "own.txt", checkpointRef: after }];
        expect(
          yield* history.restoreCheckpoint({ cwd: root, checkpointRef: before, expectedPaths }),
        ).toBe(true);
        expect(yield* fs.readFileString(`${root}/sibling.txt`)).toBe("later sibling work");
        yield* fs.writeFileString(`${root}/own.txt`, "newer edit");
        const error = yield* Effect.flip(
          history.restoreCheckpoint({ cwd: root, checkpointRef: before, expectedPaths }),
        );
        expect(error.message).toContain("changed after this Task");
        expect(yield* fs.readFileString(`${root}/own.txt`)).toBe("newer edit");
      }),
  );
  it.effect("restores an empty baseline and reports missing/deleted checkpoints", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      const state = yield* fs.makeTempDirectoryScoped();
      const history = yield* FolderCheckpoints.make(state);
      yield* history.captureCheckpoint({
        cwd: root,
        checkpointRef: CheckpointRef.make("refs/doer/empty"),
      });
      yield* fs.writeFileString(`${root}/created.txt`, "created");
      expect(
        yield* history.restoreCheckpoint({
          cwd: root,
          checkpointRef: CheckpointRef.make("refs/doer/empty"),
        }),
      ).toBe(true);
      expect(yield* fs.exists(`${root}/created.txt`)).toBe(false);
      expect(
        yield* history.restoreCheckpoint({
          cwd: root,
          checkpointRef: CheckpointRef.make("refs/doer/missing"),
        }),
      ).toBe(false);
      yield* history.deleteCheckpointRefs({
        cwd: root,
        checkpointRefs: [CheckpointRef.make("refs/doer/empty")],
      });
      expect(
        yield* history.hasCheckpointRef({
          cwd: root,
          checkpointRef: CheckpointRef.make("refs/doer/empty"),
        }),
      ).toBe(false);
    }),
  );
});
