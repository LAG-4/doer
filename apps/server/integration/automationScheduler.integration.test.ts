import {
  AutomationId,
  CommandId,
  ProjectId,
  ThreadId,
  type AutomationSchedule,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";

const PROJECT_ID = ProjectId.make("project-automation");
const THREAD_ID = ThreadId.make("thread-automation");
const AUTOMATION_ID = AutomationId.make("automation-1");

function withHarness<A, E>(use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness({}),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

const seedProjectAndThread = (harness: OrchestrationIntegrationHarness) =>
  Effect.gen(function* () {
    const createdAt = "2026-05-01T00:00:00.000Z";
    yield* harness.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-automation-project-create"),
      projectId: PROJECT_ID,
      title: "Automation Project",
      workspaceRoot: harness.workspaceDir,
      createdAt,
    });
    yield* harness.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-automation-thread-create"),
      threadId: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Automation Thread",
      modelSelection: {
        instanceId: "codex" as never,
        model: "gpt-5",
      },
      interactionMode: "default",
      runtimeMode: "auto-accept-edits",
      branch: null,
      worktreePath: harness.workspaceDir,
      createdAt,
    });
  });

describe("automation scheduling", () => {
  it.live("runs the automation lifecycle through the real engine stack", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* seedProjectAndThread(harness);
        const now = yield* DateTime.now;
        const slot = DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) + 120_000));
        const daily: AutomationSchedule = { kind: "daily", time: "09:00", timezone: "UTC" };

        yield* harness.engine.dispatch({
          type: "automation.create",
          commandId: CommandId.make("cmd-automation-create"),
          automationId: AUTOMATION_ID,
          projectId: PROJECT_ID,
          threadId: THREAD_ID,
          title: "Morning brief",
          prompt: "Summarize overnight activity.",
          schedule: { kind: "once", at: slot },
          createdAt: DateTime.formatIso(now),
        });

        const created = yield* harness.snapshotQuery.getAutomationById(AUTOMATION_ID);
        assert.isTrue(Option.isSome(created));
        if (Option.isNone(created)) return;
        assert.strictEqual(created.value.state, "active");
        assert.strictEqual(created.value.nextFireAt, slot);

        // The sweep sees nothing due before the slot.
        const earlySweep = yield* harness.snapshotQuery.listDueAutomations({
          nowIso: DateTime.formatIso(now),
        });
        assert.deepStrictEqual(earlySweep, []);

        // Switch to a daily rhythm, then pause and resume through the engine.
        yield* harness.engine.dispatch({
          type: "automation.update",
          commandId: CommandId.make("cmd-automation-update"),
          automationId: AUTOMATION_ID,
          schedule: daily,
        });
        const rescheduled = yield* harness.snapshotQuery.getAutomationById(AUTOMATION_ID);
        assert.isTrue(Option.isSome(rescheduled));

        yield* harness.engine.dispatch({
          type: "automation.pause",
          commandId: CommandId.make("cmd-automation-pause"),
          automationId: AUTOMATION_ID,
        });
        const paused = yield* harness.snapshotQuery.getAutomationById(AUTOMATION_ID);
        if (Option.isNone(paused)) return assert.fail("automation row vanished");
        assert.strictEqual(paused.value.state, "paused");
        assert.strictEqual(paused.value.nextFireAt, null);

        yield* harness.engine.dispatch({
          type: "automation.resume",
          commandId: CommandId.make("cmd-automation-resume"),
          automationId: AUTOMATION_ID,
        });
        const resumed = yield* harness.snapshotQuery.getAutomationById(AUTOMATION_ID);
        if (Option.isNone(resumed)) return assert.fail("automation row vanished");
        assert.strictEqual(resumed.value.state, "active");
        assert.isTrue(resumed.value.nextFireAt !== null);

        // The scheduler's record lands after its turn dispatch: the run is
        // stored and the next slot advances.
        const firedAt = resumed.value.nextFireAt!;
        yield* harness.engine.dispatch({
          type: "automation.fired",
          commandId: CommandId.make("cmd-automation-fired"),
          automationId: AUTOMATION_ID,
          occurrenceKey: firedAt,
          firedAt,
          outcome: "ran",
        });
        const afterFire = yield* harness.snapshotQuery.getAutomationById(AUTOMATION_ID);
        if (Option.isNone(afterFire)) return assert.fail("automation row vanished");
        assert.strictEqual(afterFire.value.lastFiredAt, firedAt);
        assert.strictEqual(afterFire.value.runs.length, 1);
        assert.isTrue(
          (afterFire.value.nextFireAt ?? "") > firedAt,
          "the next slot advances past the fired one",
        );

        // The shell snapshot carries the row for the Scheduled tasks UI.
        const shell = yield* harness.snapshotQuery.getShellSnapshot();
        assert.isTrue((shell.automations ?? []).some((row) => row.id === AUTOMATION_ID));

        // Deleting clears the slot; the tombstone stays for idempotent deletes.
        yield* harness.engine.dispatch({
          type: "automation.delete",
          commandId: CommandId.make("cmd-automation-delete"),
          automationId: AUTOMATION_ID,
        });
        const deleted = yield* harness.snapshotQuery.getAutomationById(AUTOMATION_ID);
        if (Option.isNone(deleted)) return assert.fail("automation row vanished");
        assert.isTrue(deleted.value.deletedAt !== null);
        assert.strictEqual(deleted.value.nextFireAt, null);
        const shellAfterDelete = yield* harness.snapshotQuery.getShellSnapshot();
        assert.isTrue(
          (shellAfterDelete.automations ?? []).every((row) => row.id !== AUTOMATION_ID),
        );
      }),
    ),
  );
});
