import { DOER_MEMORY_MAX_COUNT_PER_SCOPE } from "@t3tools/shared/doerMemory";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Sqlite.ts";
import { DoerMemoryStoreLive } from "./DoerMemoryStore.ts";
import { DoerMemoryStore, DoerMemoryValidationError } from "../Services/DoerMemoryStore.ts";

const memoryLayer = it.layer(
  Layer.mergeAll(
    DoerMemoryStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const NOW = "2026-09-18T12:00:00.000Z";

memoryLayer("DoerMemoryStore", (it) => {
  it.effect("creates, lists, updates, and deletes rows by id", () =>
    Effect.gen(function* () {
      const store = yield* DoerMemoryStore;
      assert.isTrue(
        yield* store.create({
          id: "mem_about_1",
          scope: "about-you",
          projectId: null,
          content: "Prefers concise summaries",
          sourceThreadId: "thread-1",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );
      assert.isTrue(
        yield* store.create({
          id: "mem_space_1",
          scope: "space",
          projectId: "project-1",
          content: "Garden budget is 4000",
          sourceThreadId: "thread-1",
          createdAt: NOW,
          updatedAt: NOW,
        }),
      );

      const scoped = yield* store.listInScope({ projectId: "project-1" });
      assert.deepEqual(
        scoped.map((row) => row.id),
        ["mem_about_1", "mem_space_1"],
      );

      const otherSpace = yield* store.listInScope({ projectId: "project-other" });
      assert.deepEqual(
        otherSpace.map((row) => row.id),
        ["mem_about_1"],
      );

      assert.isTrue(
        yield* store.updateById({
          id: "mem_space_1",
          content: "Garden budget is 5000",
          updatedAt: NOW,
        }),
      );
      const updated = yield* store.getById({ id: "mem_space_1" });
      assert.isTrue(Option.isSome(updated));
      if (Option.isSome(updated)) assert.equal(updated.value.content, "Garden budget is 5000");

      assert.isFalse(yield* store.updateById({ id: "mem_missing", content: "x", updatedAt: NOW }));
      assert.isFalse(yield* store.deleteById({ id: "mem_missing" }));
      assert.isTrue(yield* store.deleteById({ id: "mem_space_1" }));
      // A second delete reports false: the affected-row answer governs, not a prior read.
      assert.isFalse(yield* store.deleteById({ id: "mem_space_1" }));
      assert.isTrue(Option.isNone(yield* store.getById({ id: "mem_space_1" })));
    }),
  );

  it.effect("rejects invalid scope/project pairing and content bounds in the store", () =>
    Effect.gen(function* () {
      const store = yield* DoerMemoryStore;
      const invalid = yield* store
        .create({
          id: "mem_bad_scope",
          scope: "about-you",
          projectId: "project-1",
          content: "Mismatched pairing",
          sourceThreadId: "thread-1",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .pipe(Effect.flip);
      assert.instanceOf(invalid, DoerMemoryValidationError);
      const empty = yield* store
        .create({
          id: "mem_bad_content",
          scope: "space",
          projectId: "project-1",
          content: "   ",
          sourceThreadId: "thread-1",
          createdAt: NOW,
          updatedAt: NOW,
        })
        .pipe(Effect.flip);
      assert.instanceOf(empty, DoerMemoryValidationError);
      assert.isTrue(Option.isNone(yield* store.getById({ id: "mem_bad_scope" })));
    }),
  );
});

it.effect("holds the bucket cap under concurrent saves on a file database", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "doer-memory-cap-" });
      const dbPath = path.join(dir, "state.sqlite");
      const runOnDatabase = <A, E>(effect: Effect.Effect<A, E, DoerMemoryStore>) =>
        Layer.build(
          DoerMemoryStoreLive.pipe(Layer.provide(makeSqlitePersistenceLive(dbPath))),
        ).pipe(
          Effect.flatMap((context) => effect.pipe(Effect.provide(context))),
          Effect.scoped,
        );
      const inserted = yield* runOnDatabase(
        Effect.flatMap(DoerMemoryStore, (store) =>
          Effect.forEach(
            Array.from({ length: DOER_MEMORY_MAX_COUNT_PER_SCOPE + 20 }, (_, index) => index),
            (index) =>
              store.create({
                id: `mem_race_${index}`,
                scope: "space",
                projectId: "project-race",
                content: `Fact ${index}`,
                sourceThreadId: "thread-1",
                createdAt: NOW,
                updatedAt: NOW,
              }),
            { concurrency: "unbounded" },
          ),
        ),
      );
      assert.equal(inserted.filter(Boolean).length, DOER_MEMORY_MAX_COUNT_PER_SCOPE);
      const count = yield* runOnDatabase(
        Effect.flatMap(DoerMemoryStore, (store) =>
          store.countInScopeBucket({ scope: "space", projectId: "project-race" }),
        ),
      );
      assert.equal(count, DOER_MEMORY_MAX_COUNT_PER_SCOPE);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("persists rows across close and reopen of an isolated temp database", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "doer-memory-restart-" });
      const dbPath = path.join(dir, "state.sqlite");
      const runOnDatabase = <A, E>(effect: Effect.Effect<A, E, DoerMemoryStore>) =>
        Layer.build(
          DoerMemoryStoreLive.pipe(Layer.provide(makeSqlitePersistenceLive(dbPath))),
        ).pipe(
          Effect.flatMap((context) => effect.pipe(Effect.provide(context))),
          Effect.scoped,
        );
      assert.isTrue(
        yield* runOnDatabase(
          Effect.flatMap(DoerMemoryStore, (store) =>
            store.create({
              id: "mem_restart_1",
              scope: "space",
              projectId: "project-restart",
              content: "Survives restart",
              sourceThreadId: "thread-1",
              createdAt: NOW,
              updatedAt: NOW,
            }),
          ),
        ),
      );
      const reopened = yield* runOnDatabase(
        Effect.flatMap(DoerMemoryStore, (store) => store.getById({ id: "mem_restart_1" })),
      );
      assert.isTrue(Option.isSome(reopened));
      if (Option.isSome(reopened)) assert.equal(reopened.value.content, "Survives restart");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
