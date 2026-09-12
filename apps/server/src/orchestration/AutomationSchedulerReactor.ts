import { CommandId, MessageId } from "@t3tools/contracts";
import type { Automation } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import { isoMinusMs, planFiring } from "./AutomationSchedule.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class AutomationSchedulerReactor extends Context.Service<
  AutomationSchedulerReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/AutomationSchedulerReactor") {}

const DUE_SWEEP_LIMIT = 50;
/**
 * Grace between a scheduled firing and auto-settling its thread: the turn's
 * checkpoint and diff work lands after the provider finishes, and settling
 * must never race it.
 */
const SETTLE_GRACE_MS = 5 * 60_000;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const fireAutomation = Effect.fn("AutomationSchedulerReactor.fireAutomation")(function* (
    automation: Automation,
    now: string,
  ) {
    const planned = planFiring({
      schedule: automation.schedule,
      nextFireAt: automation.nextFireAt,
      nowIso: now,
    });
    if (planned === null) {
      return;
    }
    // The row may have changed between the sweep read and this firing (the
    // user paused, edited, or deleted it). Re-read: only the stored slot
    // still fires, so stale work never starts a turn.
    const current = yield* snapshots.getAutomationById(automation.id);
    if (
      Option.isNone(current) ||
      current.value.state !== "active" ||
      current.value.nextFireAt !== planned.occurrenceKey
    ) {
      return;
    }
    const thread = yield* snapshots.getThreadShellById(automation.threadId);
    if (Option.isNone(thread)) {
      return yield* Effect.logWarning("scheduled automation skipped: thread is gone", {
        automationId: automation.id,
        threadId: automation.threadId,
      });
    }
    const turnCommandId = CommandId.make(
      `server:automation:${automation.id}:${planned.occurrenceKey}`,
    );
    // Scheduled runs are unattended by contract: the thread runs on full
    // access even if its mode drifted (the user flipped it, an import set
    // it) since the last firing.
    if (thread.value.runtimeMode !== "full-access") {
      yield* engine.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(`${turnCommandId}:mode`),
        threadId: automation.threadId,
        runtimeMode: "full-access",
        createdAt: now,
      });
    }
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: turnCommandId,
      threadId: automation.threadId,
      message: {
        messageId: MessageId.make(`automation:${automation.id}:${planned.occurrenceKey}`),
        role: "user",
        text: automation.prompt,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: thread.value.interactionMode,
      createdAt: now,
    });
    // The turn dispatch is idempotent on its command id, and the record
    // rejects an already-recorded occurrence key: a repeated sweep can
    // never double-fire, even across a crash between the two dispatches.
    yield* engine.dispatch({
      type: "automation.fired",
      commandId: CommandId.make(`${turnCommandId}:record`),
      automationId: automation.id,
      occurrenceKey: planned.occurrenceKey,
      firedAt: now,
      outcome: planned.outcome,
    });
  });

  /**
   * Settle the thread of a firing whose run finished: a completed scheduled
   * run parks itself instead of lingering in Active. Only the automation's
   * own turn qualifies — a newer user turn (requested after the firing)
   * skips settlement — and settle's own guards (session, approvals, queued
   * turns) still apply inside the decider.
   */
  const settleAutomationThread = Effect.fn("AutomationSchedulerReactor.settleAutomationThread")(
    function* (automation: Automation) {
      if (automation.lastFiredAt === null) {
        return;
      }
      const thread = yield* snapshots.getThreadShellById(automation.threadId);
      if (Option.isNone(thread)) {
        return;
      }
      const shell = thread.value;
      if (shell.settledOverride === "settled") {
        return;
      }
      if (shell.session?.status === "starting" || shell.session?.status === "running") {
        return;
      }
      if (shell.hasPendingApprovals || shell.hasPendingUserInput) {
        return;
      }
      const latestTurn = shell.latestTurn;
      if (
        latestTurn === null ||
        latestTurn.state === "running" ||
        latestTurn.requestedAt > automation.lastFiredAt
      ) {
        return;
      }
      yield* engine
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(
            `server:automation:${automation.id}:settle:${automation.lastFiredAt}`,
          ),
          threadId: automation.threadId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logDebug("scheduled automation thread not settled", {
                  automationId: automation.id,
                  threadId: automation.threadId,
                  cause: Cause.pretty(cause),
                }),
          ),
        );
    },
  );

  const sweep = Effect.fn("AutomationSchedulerReactor.sweep")(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    const due = yield* snapshots.listDueAutomations({ nowIso: now, limit: DUE_SWEEP_LIMIT });
    // Per-item failures are caught to warnings so one bad automation cannot
    // starve the rest of the sweep.
    yield* Effect.forEach(
      due,
      (automation) =>
        fireAutomation(automation, now).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("scheduled automation firing skipped", {
                  automationId: automation.id,
                  cause: Cause.pretty(cause),
                }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    const settleCutoff = isoMinusMs(now, SETTLE_GRACE_MS);
    if (settleCutoff !== null) {
      const candidates = yield* snapshots.listSettleCandidateAutomations({
        firedBeforeIso: settleCutoff,
        limit: DUE_SWEEP_LIMIT,
      });
      yield* Effect.forEach(
        candidates,
        (automation) =>
          settleAutomationThread(automation).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning("scheduled automation settle sweep skipped", {
                    automationId: automation.id,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        { concurrency: 4, discard: true },
      );
    }
  });

  const runSweep = () =>
    sweep().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("scheduled automation sweep failed", {
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(() => runSweep());

  const start: AutomationSchedulerReactor["Service"]["start"] = Effect.fn(
    "AutomationSchedulerReactor.start",
  )(function* () {
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
  });

  return { start, drain: worker.drain } satisfies AutomationSchedulerReactor["Service"];
});

export const layer = Layer.effect(AutomationSchedulerReactor, make);
