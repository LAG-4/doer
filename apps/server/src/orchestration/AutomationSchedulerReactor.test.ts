import {
  AutomationId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Automation,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as AutomationSchedulerReactor from "./AutomationSchedulerReactor.ts";

// The reactor clock is the Effect test clock: sweeps read "now" from it.
const NOW = "2026-09-18T12:00:00.000Z";
const SLOT = "2026-09-18T09:00:00.000Z";
// A slot 30 seconds old: inside the missed threshold, so it fires as "ran".
const FRESH_SLOT = "2026-09-18T11:59:30.000Z";

function makeAutomation(id: string, overrides: Partial<Automation> = {}): Automation {
  return {
    id: AutomationId.make(id),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make(`thread-for-${id}`),
    title: `Automation ${id}`,
    prompt: `Prompt for ${id}.`,
    schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
    state: "active",
    nextFireAt: SLOT,
    lastFiredAt: null,
    runs: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    deletedAt: null,
    ...overrides,
  };
}

function makeThreadShell(threadId: string): OrchestrationThreadShell {
  return {
    id: ThreadId.make(threadId),
    projectId: ProjectId.make("project-1"),
    title: threadId,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

type DispatchedCommand = OrchestrationCommand;

interface HarnessOptions {
  readonly dueRows: ReadonlyArray<Automation>;
  readonly automationsById?: ReadonlyMap<string, Automation>;
  readonly missingThreads?: ReadonlyArray<string>;
  readonly onDispatch?: (
    command: DispatchedCommand,
  ) => Effect.Effect<void, OrchestrationCommandInvariantError>;
}

const makeHarness = Effect.fn("makeAutomationSchedulerHarness")(function* (
  options: HarnessOptions,
) {
  const activation = yield* Deferred.make<void>();
  const dueRows = yield* Ref.make(options.dueRows);
  const sweepReads = yield* Queue.unbounded<number>();
  const sweepCount = yield* Ref.make(0);
  const commands = yield* Ref.make<ReadonlyArray<DispatchedCommand>>([]);
  const byId = new Map<string, Automation>();
  for (const row of options.dueRows) {
    byId.set(row.id, row);
  }
  for (const [id, row] of options.automationsById ?? []) {
    byId.set(id, row);
  }
  const missingThreads = new Set(options.missingThreads ?? []);

  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Ref.update(commands, (recorded) => [...recorded, command]).pipe(
      Effect.andThen(options.onDispatch?.(command) ?? Effect.void),
      Effect.as({ sequence: 1 }),
    );

  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      listDueAutomations: () =>
        Ref.updateAndGet(sweepCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(sweepReads, count)),
          Effect.andThen(Ref.get(dueRows)),
        ),
      getAutomationById: (automationId: AutomationId) =>
        Effect.succeed(
          byId.get(automationId) === undefined
            ? Option.none()
            : Option.some(byId.get(automationId)!),
        ),
      getThreadShellById: (threadId: ThreadId) =>
        Effect.succeed(
          missingThreads.has(threadId) ? Option.none() : Option.some(makeThreadShell(threadId)),
        ),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(ServerActivation, Deferred.await(activation)),
  );

  return {
    activation,
    commands,
    dueRows,
    sweepReads,
    layer: AutomationSchedulerReactor.layer.pipe(Layer.provide(dependencies)),
  };
});

const startHarness = Effect.fn("startAutomationSchedulerHarness")(function* (
  reactor: AutomationSchedulerReactor.AutomationSchedulerReactor["Service"],
  activation: Deferred.Deferred<void>,
  sweepReads: Queue.Queue<number>,
) {
  yield* reactor.start();
  yield* Deferred.succeed(activation, undefined);
  yield* Queue.take(sweepReads);
  yield* reactor.drain;
});

describe("AutomationSchedulerReactor", () => {
  it.effect("fires a due automation with an idempotent command pair", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          dueRows: [makeAutomation("automation-1", { nextFireAt: FRESH_SLOT })],
        });
        yield* Effect.gen(function* () {
          const reactor = yield* AutomationSchedulerReactor.AutomationSchedulerReactor;
          yield* startHarness(reactor, fixture.activation, fixture.sweepReads);
          const dispatched = yield* Ref.get(fixture.commands);
          assert.strictEqual(dispatched.length, 2);

          const turnStart = dispatched[0];
          assert.strictEqual(turnStart?.type, "thread.turn.start");
          if (turnStart?.type === "thread.turn.start") {
            expect(turnStart.commandId).toBe(`server:automation:automation-1:${FRESH_SLOT}`);
            expect(turnStart.threadId).toBe("thread-for-automation-1");
            expect(turnStart.message.text).toBe("Prompt for automation-1.");
            // The turn resolves its permission policy from the thread, but
            // the scheduler still passes the thread's modes through.
            expect(turnStart.runtimeMode).toBe("auto-accept-edits");
          }

          const fired = dispatched[1];
          assert.strictEqual(fired?.type, "automation.fired");
          if (fired?.type === "automation.fired") {
            expect(fired.commandId).toBe(`server:automation:automation-1:${FRESH_SLOT}:record`);
            expect(fired.occurrenceKey).toBe(FRESH_SLOT);
            expect(fired.outcome).toBe("ran");
          }
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("marks a long-overdue slot missed-then-ran", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const stale = makeAutomation("automation-stale", {
          nextFireAt: "2026-09-15T09:00:00.000Z",
        });
        const fixture = yield* makeHarness({ dueRows: [stale] });
        yield* Effect.gen(function* () {
          const reactor = yield* AutomationSchedulerReactor.AutomationSchedulerReactor;
          yield* startHarness(reactor, fixture.activation, fixture.sweepReads);
          const dispatched = yield* Ref.get(fixture.commands);
          const fired = dispatched.find((command) => command.type === "automation.fired");
          assert.strictEqual(fired?.type, "automation.fired");
          if (fired?.type === "automation.fired") {
            expect(fired.occurrenceKey).toBe("2026-09-15T09:00:00.000Z");
            expect(fired.outcome).toBe("missed-then-ran");
          }
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips automations that changed since the sweep read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const live = makeAutomation("automation-live");
        const paused = makeAutomation("automation-paused", { state: "paused", nextFireAt: null });
        // The sweep saw both as due; by firing time one is paused.
        const fixture = yield* makeHarness({
          dueRows: [live, paused],
          automationsById: new Map([
            ["automation-live", live],
            ["automation-paused", paused],
          ]),
        });
        yield* Effect.gen(function* () {
          const reactor = yield* AutomationSchedulerReactor.AutomationSchedulerReactor;
          yield* startHarness(reactor, fixture.activation, fixture.sweepReads);
          const dispatched = yield* Ref.get(fixture.commands);
          const firedIds = dispatched
            .filter((command) => command.type === "automation.fired")
            .map((command) =>
              command.type === "automation.fired" ? String(command.automationId) : null,
            );
          assert.deepStrictEqual(firedIds, ["automation-live"]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("skips automations whose thread is gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          dueRows: [makeAutomation("automation-orphan")],
          missingThreads: ["thread-for-automation-orphan"],
        });
        yield* Effect.gen(function* () {
          const reactor = yield* AutomationSchedulerReactor.AutomationSchedulerReactor;
          yield* startHarness(reactor, fixture.activation, fixture.sweepReads);
          assert.deepStrictEqual(yield* Ref.get(fixture.commands), []);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("isolates per-automation failures across the sweep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          dueRows: [makeAutomation("automation-bad"), makeAutomation("automation-good")],
          onDispatch: (command) =>
            command.type === "thread.turn.start" && command.threadId === "thread-for-automation-bad"
              ? new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "boom",
                })
              : Effect.void,
        });
        yield* Effect.gen(function* () {
          const reactor = yield* AutomationSchedulerReactor.AutomationSchedulerReactor;
          yield* startHarness(reactor, fixture.activation, fixture.sweepReads);
          const dispatched = yield* Ref.get(fixture.commands);
          // The bad automation's turn failed: its run is never recorded, but
          // the good automation still fires its full pair.
          const firedIds = dispatched
            .filter((command) => command.type === "automation.fired")
            .map((command) =>
              command.type === "automation.fired" ? String(command.automationId) : null,
            );
          assert.deepStrictEqual(firedIds, ["automation-good"]);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );

  it.effect("a later sweep with nothing due dispatches nothing new", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const fixture = yield* makeHarness({
          dueRows: [makeAutomation("automation-1", { nextFireAt: FRESH_SLOT })],
        });
        yield* Effect.gen(function* () {
          const reactor = yield* AutomationSchedulerReactor.AutomationSchedulerReactor;
          yield* startHarness(reactor, fixture.activation, fixture.sweepReads);
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 2);
          // The fired record advanced the slot: the next sweep sees no rows.
          yield* Ref.set(fixture.dueRows, []);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(fixture.sweepReads);
          yield* reactor.drain;
          assert.strictEqual((yield* Ref.get(fixture.commands)).length, 2);
        }).pipe(Effect.provide(fixture.layer));
      }),
    ),
  );
});
