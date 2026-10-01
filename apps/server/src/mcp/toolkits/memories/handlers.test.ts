import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { DoerMemory } from "@t3tools/shared/doerMemory";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { DoerMemoryStore } from "../../../persistence/Services/DoerMemoryStore.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { MemoriesToolkitHandlersLive } from "./handlers.ts";
import { MemoriesToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const NOW = "2026-09-18T12:00:00.000Z";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(),
  issuedAt: 1,
});

function makeThread(): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

const makeHarness = Effect.fn("makeMemoriesToolkitHarness")(function* (
  seed: ReadonlyArray<DoerMemory> = [],
) {
  const rows = yield* Ref.make(new Map(seed.map((row) => [row.id, row])));
  const read = Ref.get(rows).pipe(Effect.map((map) => [...map.values()]));
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.some(makeThread()) : Option.none()),
    }),
    Layer.mock(DoerMemoryStore)({
      create: (input) =>
        Ref.modify(rows, (map) => {
          if (map.has(input.id)) throw new Error("duplicate id");
          const bucketed = [...map.values()].filter(
            (row) => row.scope === input.scope && (row.projectId ?? null) === input.projectId,
          ).length;
          // Mirror the atomic store gate: false when the bucket is full.
          if (bucketed >= 100) return [false, map] as const;
          return [true, new Map(map).set(input.id, { ...input })] as const;
        }),
      listInScope: ({ projectId }) =>
        read.pipe(
          Effect.map((all) =>
            all.filter((row) => row.scope === "about-you" || row.projectId === projectId),
          ),
        ),
      listAboutYou: () =>
        read.pipe(Effect.map((all) => all.filter((row) => row.scope === "about-you"))),
      listForSpace: ({ projectId }) =>
        read.pipe(
          Effect.map((all) =>
            all.filter((row) => row.scope === "space" && row.projectId === projectId),
          ),
        ),
      getById: ({ id }) =>
        read.pipe(
          Effect.map((all) => {
            const found = all.find((row) => row.id === id);
            return found === undefined ? Option.none() : Option.some(found);
          }),
        ),
      countInScopeBucket: ({ scope, projectId }) =>
        read.pipe(
          Effect.map(
            (all) =>
              all.filter((row) => row.scope === scope && (row.projectId ?? null) === projectId)
                .length,
          ),
        ),
      updateById: ({ id, content, updatedAt }) =>
        Ref.modify(rows, (map) => {
          const existing = map.get(id);
          if (!existing) return [false, map] as const;
          return [true, new Map(map).set(id, { ...existing, content, updatedAt })] as const;
        }),
      deleteById: ({ id }) =>
        Ref.modify(rows, (map) => {
          if (!map.has(id)) return [false, map] as const;
          const next = new Map(map);
          next.delete(id);
          return [true, next] as const;
        }),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* MemoriesToolkit.pipe(
    Effect.provide(MemoriesToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof MemoriesToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof MemoriesToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation()),
      Effect.provide(dependencies),
    );
  return { rows, call };
});

const seedEntry = (
  overrides: Partial<DoerMemory> & { id: string; content: string },
): DoerMemory => ({
  scope: "space",
  projectId: String(PROJECT_ID),
  sourceThreadId: String(THREAD_ID),
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("memories toolkit handlers", () => {
  it.effect("remembers into the calling task's space and confirms the persisted result", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("remember_memory", {
        content: "Garden budget is 4000",
      });
      expect(result.memory.content).toBe("Garden budget is 4000");
      expect(result.memory.scope).toBe("space");
      expect(result.memory.projectId).toBe(String(PROJECT_ID));
      expect(result.memory.sourceThreadId).toBe(String(THREAD_ID));
      expect(result.message).toMatch(/This Space/);
      // The confirmation reflects a real re-read, not the request echo.
      const stored = yield* Ref.get(harness.rows);
      expect(stored.get(result.memory.id)?.content).toBe("Garden budget is 4000");
    }),
  );

  it.effect("saves about-you entries when asked and lists both scopes together", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const saved = yield* harness.call("remember_memory", {
        content: "Prefers concise summaries",
        scope: "about-you",
      });
      expect(saved.memory.projectId).toBe(null);
      expect(saved.message).toMatch(/About you/);
      const listed = yield* harness.call("list_memories", {});
      expect(listed.memories.map((row) => row.id)).toEqual([saved.memory.id]);
    }),
  );

  it.effect("lists and searches only the caller's scope", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        seedEntry({ id: "mem_mine", content: "Garden budget is 4000" }),
        seedEntry({ id: "mem_foreign", content: "Foreign fact", projectId: "project-other" }),
        seedEntry({
          id: "mem_about",
          content: "Prefers mornings",
          scope: "about-you",
          projectId: null,
        }),
      ]);
      const listed = yield* harness.call("list_memories", {});
      expect(listed.memories.map((row) => row.id).sort()).toEqual(["mem_about", "mem_mine"]);
      const spaceOnly = yield* harness.call("list_memories", { scope: "space" });
      expect(spaceOnly.memories.map((row) => row.id)).toEqual(["mem_mine"]);
      const found = yield* harness.call("search_memories", { query: "garden" });
      expect(found.memories.map((row) => row.id)).toEqual(["mem_mine"]);
    }),
  );

  it.effect("rejects foreign ids on update and delete", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        seedEntry({ id: "mem_foreign", content: "Foreign fact", projectId: "project-other" }),
      ]);
      const updateError = yield* harness
        .call("update_memory", { memoryId: "mem_foreign", content: "Changed" })
        .pipe(Effect.flip);
      expect(updateError._tag).toBe("MemoryNotFoundError");
      const deleteError = yield* harness
        .call("forget_memory", { memoryId: "mem_foreign" })
        .pipe(Effect.flip);
      expect(deleteError._tag).toBe("MemoryNotFoundError");
      const missing = yield* harness
        .call("forget_memory", { memoryId: "mem_missing" })
        .pipe(Effect.flip);
      expect(missing._tag).toBe("MemoryNotFoundError");
    }),
  );

  it.effect("updates and forgets with honest confirmations", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([
        seedEntry({ id: "mem_mine", content: "Garden budget is 4000" }),
      ]);
      const updated = yield* harness.call("update_memory", {
        memoryId: "mem_mine",
        content: "Garden budget is 5000",
      });
      expect(updated.memory.content).toBe("Garden budget is 5000");
      expect(updated.message).toMatch(/corrected/);
      const forgotten = yield* harness.call("forget_memory", { memoryId: "mem_mine" });
      expect(forgotten.memoryId).toBe("mem_mine");
      expect(forgotten.message).toMatch(/will not appear in future messages/);
      const listed = yield* harness.call("list_memories", {});
      expect(listed.memories).toEqual([]);
    }),
  );

  it.effect("refuses secrets without claiming a save", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("remember_memory", { content: "password: hunter2-hunter2" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("MemorySaveFailedError");
      const listed = yield* harness.call("list_memories", {});
      expect(listed.memories).toEqual([]);
    }),
  );
});
