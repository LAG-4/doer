import {
  DOER_MEMORY_MAX_COUNT_PER_SCOPE,
  findDoerMemorySecretProblem,
  normalizeDoerMemoryContent,
  type DoerMemory,
  type DoerMemoryScope,
} from "@t3tools/shared/doerMemory";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as DoerMemoryStore from "../../../persistence/Services/DoerMemoryStore.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  MemoriesToolkit,
  MemoryForgetFailedError,
  MemoryListFailedError,
  MemoryNotFoundError,
  MemorySaveFailedError,
  MemorySearchFailedError,
  MemoryUpdateFailedError,
} from "./tools.ts";

type MemoryFailure =
  | typeof MemorySaveFailedError
  | typeof MemoryListFailedError
  | typeof MemorySearchFailedError
  | typeof MemoryUpdateFailedError
  | typeof MemoryForgetFailedError;

const dispatchFailure =
  (Failure: MemoryFailure) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<never, InstanceType<MemoryFailure>> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.failCause(cause as Cause.Cause<never>)
      : Effect.fail(new Failure({ cause }) as InstanceType<MemoryFailure>);

const make = Effect.gen(function* () {
  const store = yield* DoerMemoryStore.DoerMemoryStore;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const newMemoryId = crypto.randomUUIDv4.pipe(
    Effect.orDie,
    Effect.map((uuid) => `mem_${uuid}`),
  );

  /** The calling Task's thread; scope always resolves from here, never from caller ids. */
  const requireScopeThread = Effect.fn("MemoriesToolkit.requireScopeThread")(function* (
    Failure: MemoryFailure,
  ) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(thread)) {
      return yield* new Failure({
        cause: new Error("This Task is no longer available, so memories cannot be read here."),
      });
    }
    return { scope, thread: thread.value };
  });

  /** Enforce entry scope: Space entries only from their own Space. */
  const requireVisible = Effect.fn("MemoriesToolkit.requireVisible")(function* (
    entry: DoerMemory,
    projectId: string,
    memoryId: string,
  ) {
    if (entry.scope === "space" && entry.projectId !== projectId) {
      return yield* new MemoryNotFoundError({ memoryId });
    }
    return entry;
  });

  const readBack = Effect.fn("MemoriesToolkit.readBack")(function* (
    id: string,
    Failure: MemoryFailure,
  ) {
    const entry = yield* store
      .getById({ id })
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(entry)) {
      return yield* new MemoryNotFoundError({ memoryId: id });
    }
    return entry.value;
  });

  const checkContent = (content: string, Failure: MemoryFailure) =>
    Effect.gen(function* () {
      const normalized = normalizeDoerMemoryContent(content);
      const secret = findDoerMemorySecretProblem(normalized);
      if (secret !== null) {
        return yield* new Failure({
          cause: new Error(`${secret} Nothing was saved.`),
        });
      }
      return normalized;
    });

  const savedMessage = (scope: DoerMemoryScope) =>
    scope === "about-you"
      ? "Saved to About you. Available starting next message, across Spaces on this computer."
      : "Saved to This Space. Available starting next message in this Space.";

  const bucketFullMessage = (scope: DoerMemoryScope) =>
    scope === "about-you"
      ? `About you already holds ${DOER_MEMORY_MAX_COUNT_PER_SCOPE} memories. Forget one before saving another. Nothing was saved.`
      : `This Space already holds ${DOER_MEMORY_MAX_COUNT_PER_SCOPE} memories. Forget one before saving another. Nothing was saved.`;

  return MemoriesToolkit.of({
    remember_memory: (input) =>
      Effect.gen(function* () {
        const { scope: invocation, thread } = yield* requireScopeThread(MemorySaveFailedError);
        const scope = input.scope ?? "space";
        const content = yield* checkContent(input.content, MemorySaveFailedError);
        const projectId = scope === "about-you" ? null : String(thread.projectId);
        const occurredAt = yield* nowIso;
        const id = yield* newMemoryId;
        // The store enforces the bucket cap atomically: false means full.
        const inserted = yield* store
          .create({
            id,
            scope,
            projectId,
            content,
            sourceThreadId: String(invocation.threadId),
            createdAt: occurredAt,
            updatedAt: occurredAt,
          })
          .pipe(Effect.catchCause(dispatchFailure(MemorySaveFailedError)));
        if (!inserted) {
          return yield* new MemorySaveFailedError({ cause: new Error(bucketFullMessage(scope)) });
        }
        const memory = yield* readBack(id, MemorySaveFailedError);
        return { memory, message: savedMessage(scope) };
      }),

    list_memories: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(MemoryListFailedError);
        const projectId = String(thread.projectId);
        if (input.scope === "about-you") {
          return {
            memories: yield* store
              .listAboutYou()
              .pipe(Effect.catchCause(dispatchFailure(MemoryListFailedError))),
          };
        }
        if (input.scope === "space") {
          return {
            memories: yield* store
              .listForSpace({ projectId })
              .pipe(Effect.catchCause(dispatchFailure(MemoryListFailedError))),
          };
        }
        return {
          memories: yield* store
            .listInScope({ projectId })
            .pipe(Effect.catchCause(dispatchFailure(MemoryListFailedError))),
        };
      }),

    search_memories: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(MemorySearchFailedError);
        const needle = normalizeDoerMemoryContent(input.query).toLowerCase();
        const entries = yield* store
          .listInScope({ projectId: String(thread.projectId) })
          .pipe(Effect.catchCause(dispatchFailure(MemorySearchFailedError)));
        return {
          query: input.query,
          memories: entries
            .filter((entry) => entry.content.toLowerCase().includes(needle))
            .slice(0, 20),
        };
      }),

    update_memory: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(MemoryUpdateFailedError);
        const projectId = String(thread.projectId);
        const existing = yield* store
          .getById({ id: input.memoryId })
          .pipe(Effect.catchCause(dispatchFailure(MemoryUpdateFailedError)));
        if (Option.isNone(existing)) {
          return yield* new MemoryNotFoundError({ memoryId: input.memoryId });
        }
        yield* requireVisible(existing.value, projectId, input.memoryId);
        const content = yield* checkContent(input.content, MemoryUpdateFailedError);
        const updatedAt = yield* nowIso;
        // The affected-row answer governs: false means the id vanished under us.
        const updated = yield* store
          .updateById({ id: input.memoryId, content, updatedAt })
          .pipe(Effect.catchCause(dispatchFailure(MemoryUpdateFailedError)));
        if (!updated) {
          return yield* new MemoryNotFoundError({ memoryId: input.memoryId });
        }
        const memory = yield* readBack(input.memoryId, MemoryUpdateFailedError);
        return {
          memory,
          message:
            "Updated. The corrected version is available starting next message. Earlier conversation may still contain the old wording.",
        };
      }),

    forget_memory: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(MemoryForgetFailedError);
        const projectId = String(thread.projectId);
        const existing = yield* store
          .getById({ id: input.memoryId })
          .pipe(Effect.catchCause(dispatchFailure(MemoryForgetFailedError)));
        if (Option.isNone(existing)) {
          return yield* new MemoryNotFoundError({ memoryId: input.memoryId });
        }
        const visible = yield* requireVisible(existing.value, projectId, input.memoryId);
        const deleted = yield* store
          .deleteById({ id: input.memoryId })
          .pipe(Effect.catchCause(dispatchFailure(MemoryForgetFailedError)));
        if (!deleted) {
          return yield* new MemoryNotFoundError({ memoryId: input.memoryId });
        }
        return {
          memoryId: input.memoryId,
          scope: visible.scope,
          message:
            "Forgotten. It will not appear in future messages. Earlier conversation with a provider may still contain it.",
        };
      }),
  });
});

export const MemoriesToolkitHandlersLive = MemoriesToolkit.toLayer(make);
