import {
  AutomationId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Automation,
  type AutomationSchedule,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
// The decider's clock is the Effect test clock, pinned to the epoch, so
// "future" fire times are relative to 1970-01-01T00:00:00.000Z.
const FUTURE_FIRE = "1970-01-02T09:00:00.000Z";
const PAST_FIRE = "1969-12-31T09:00:00.000Z";

const ONCE_FUTURE: AutomationSchedule = { kind: "once", at: FUTURE_FIRE };
const ONCE_PAST: AutomationSchedule = { kind: "once", at: PAST_FIRE };
const DAILY: AutomationSchedule = { kind: "daily", time: "09:00", timezone: "UTC" };

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: ThreadId.make("thread-1"),
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "auto-accept-edits",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeAutomation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: AutomationId.make("automation-1"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    title: "Morning brief",
    prompt: "Summarize overnight activity.",
    schedule: ONCE_FUTURE,
    state: "active",
    nextFireAt: FUTURE_FIRE,
    lastFiredAt: null,
    runs: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function makeReadModel(
  input: {
    readonly projects?: OrchestrationReadModel["projects"];
    readonly thread?: OrchestrationThread | null;
    readonly automations?: ReadonlyArray<Automation>;
  } = {},
): OrchestrationReadModel {
  const projects =
    input.projects ??
    (input.thread === null && (input.automations ?? []).length === 0
      ? []
      : [
          {
            id: ProjectId.make("project-1"),
            title: "Project",
            workspaceRoot: "/tmp/project-1",
            defaultModelSelection: null,
            scripts: [],
            createdAt: NOW,
            updatedAt: NOW,
            deletedAt: null,
          },
        ]);
  return {
    snapshotSequence: 0,
    projects,
    threads: input.thread === null ? [] : [input.thread ?? makeThread()],
    automations: [...(input.automations ?? [])],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("automation decider", (it) => {
  it.effect("creates an automation with its first firing", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "automation.create",
          commandId: CommandId.make("cmd-automation-create"),
          automationId: AutomationId.make("automation-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          title: "Morning brief",
          prompt: "Summarize overnight activity.",
          schedule: ONCE_FUTURE,
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("automation.created");
      if (events[0]?.type === "automation.created") {
        expect(events[0].aggregateKind).toBe("automation");
        expect(events[0].aggregateId).toBe("automation-1");
        expect(events[0].payload.nextFireAt).toBe(FUTURE_FIRE);
      }
    }),
  );

  it.effect("rejects creation with a fire time that is not in the future", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "automation.create",
          commandId: CommandId.make("cmd-automation-past"),
          automationId: AutomationId.make("automation-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          title: "Morning brief",
          prompt: "Summarize overnight activity.",
          schedule: ONCE_PAST,
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects creation with an unknown timezone", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "automation.create",
          commandId: CommandId.make("cmd-automation-tz"),
          automationId: AutomationId.make("automation-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          title: "Morning brief",
          prompt: "Summarize overnight activity.",
          schedule: { kind: "daily", time: "09:00", timezone: "Mars/Olympus" },
          createdAt: NOW,
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("rejects creation for an unknown Space, a missing thread, or a duplicate id", () =>
    Effect.gen(function* () {
      const base = {
        type: "automation.create" as const,
        commandId: CommandId.make("cmd-automation-bad"),
        title: "Morning brief",
        prompt: "Summarize overnight activity.",
        schedule: ONCE_FUTURE,
        createdAt: NOW,
      };
      const unknownProject = yield* decideOrchestrationCommand({
        command: {
          ...base,
          automationId: AutomationId.make("automation-1"),
          projectId: ProjectId.make("project-missing"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(unknownProject._tag).toBe("OrchestrationCommandInvariantError");

      const missingThread = yield* decideOrchestrationCommand({
        command: {
          ...base,
          automationId: AutomationId.make("automation-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-missing"),
        },
        readModel: makeReadModel({}),
      }).pipe(Effect.flip);
      expect(missingThread._tag).toBe("OrchestrationCommandInvariantError");

      const otherProjectThread = yield* decideOrchestrationCommand({
        command: {
          ...base,
          automationId: AutomationId.make("automation-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({
          thread: makeThread({ projectId: ProjectId.make("project-other") }),
        }),
      }).pipe(Effect.flip);
      expect(otherProjectThread._tag).toBe("OrchestrationCommandInvariantError");

      const duplicate = yield* decideOrchestrationCommand({
        command: {
          ...base,
          automationId: AutomationId.make("automation-1"),
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel({ automations: [makeAutomation()] }),
      }).pipe(Effect.flip);
      expect(duplicate._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("updates title and prompt, and reschedules on schedule change", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "automation.update",
          commandId: CommandId.make("cmd-automation-update"),
          automationId: AutomationId.make("automation-1"),
          title: "Evening brief",
          prompt: "Summarize the day.",
          schedule: DAILY,
        },
        readModel: makeReadModel({ automations: [makeAutomation()] }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("automation.updated");
      if (events[0]?.type === "automation.updated") {
        expect(events[0].payload.title).toBe("Evening brief");
        expect(events[0].payload.prompt).toBe("Summarize the day.");
        expect(events[0].payload.schedule).toEqual(DAILY);
        // Rescheduled from the decider clock (the epoch): next firing is set.
        expect(events[0].payload.nextFireAt).toBe("1970-01-01T09:00:00.000Z");
      }
    }),
  );

  it.effect("rejects empty updates and updates on completed automations", () =>
    Effect.gen(function* () {
      const empty = yield* decideOrchestrationCommand({
        command: {
          type: "automation.update",
          commandId: CommandId.make("cmd-automation-empty"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({ automations: [makeAutomation()] }),
      }).pipe(Effect.flip);
      expect(empty._tag).toBe("OrchestrationCommandInvariantError");

      const completed = yield* decideOrchestrationCommand({
        command: {
          type: "automation.update",
          commandId: CommandId.make("cmd-automation-completed"),
          automationId: AutomationId.make("automation-1"),
          title: "Late rename",
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ state: "completed", nextFireAt: null })],
        }),
      }).pipe(Effect.flip);
      expect(completed._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("pauses and re-pauses idempotently", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "automation.pause",
          commandId: CommandId.make("cmd-automation-pause"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({ automations: [makeAutomation()] }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("automation.paused");
      if (events[0]?.type === "automation.paused") {
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }

      const again = yield* decideOrchestrationCommand({
        command: {
          type: "automation.pause",
          commandId: CommandId.make("cmd-automation-pause-again"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ state: "paused", nextFireAt: null })],
        }),
      });
      const againEvents = Array.isArray(again) ? again : [again];
      if (againEvents[0]?.type === "automation.paused") {
        // No state change — keep the existing updatedAt.
        expect(againEvents[0].payload.updatedAt).toBe(NOW);
      } else {
        expect.unreachable("expected automation.paused");
      }
    }),
  );

  it.effect("resumes with a recomputed firing, and rejects a spent schedule", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "automation.resume",
          commandId: CommandId.make("cmd-automation-resume"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ state: "paused", nextFireAt: null, schedule: DAILY })],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("automation.resumed");
      if (events[0]?.type === "automation.resumed") {
        expect(events[0].payload.nextFireAt).toBe("1970-01-01T09:00:00.000Z");
        expect(events[0].payload.updatedAt).not.toBe(NOW);
      }

      // Paused before the fire time, resumed after it: a once schedule has
      // nothing left, so resume is rejected instead of arming a dead row.
      const spent = yield* decideOrchestrationCommand({
        command: {
          type: "automation.resume",
          commandId: CommandId.make("cmd-automation-resume-spent"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ state: "paused", nextFireAt: null, schedule: ONCE_PAST })],
        }),
      }).pipe(Effect.flip);
      expect(spent._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("deletes and re-deletes idempotently", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "automation.delete",
          commandId: CommandId.make("cmd-automation-delete"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({ automations: [makeAutomation()] }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events[0]?.type).toBe("automation.deleted");

      const again = yield* decideOrchestrationCommand({
        command: {
          type: "automation.delete",
          commandId: CommandId.make("cmd-automation-delete-again"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ deletedAt: NOW, nextFireAt: null })],
        }),
      });
      const againEvents = Array.isArray(again) ? again : [again];
      if (againEvents[0]?.type === "automation.deleted") {
        expect(againEvents[0].payload.deletedAt).toBe(NOW);
        expect(againEvents[0].payload.updatedAt).toBe(NOW);
      } else {
        expect.unreachable("expected automation.deleted");
      }
    }),
  );

  it.effect("run-now starts a turn with the stored prompt and records a manual run", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "automation.run-now",
          commandId: CommandId.make("cmd-automation-run-now"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({ automations: [makeAutomation()] }),
      });
      const events = Array.isArray(result) ? result : [result];
      const turnStart = events.find((entry) => entry.type === "thread.turn-start-requested");
      expect(turnStart).toBeDefined();
      if (turnStart?.type === "thread.turn-start-requested") {
        expect(turnStart.aggregateId).toBe("thread-1");
      }
      const message = events.find((entry) => entry.type === "thread.message-sent");
      expect(message).toBeDefined();
      if (message?.type === "thread.message-sent") {
        expect(message.payload.text).toBe("Summarize overnight activity.");
      }
      const fired = events.find((entry) => entry.type === "automation.fired");
      expect(fired).toBeDefined();
      if (fired?.type === "automation.fired") {
        expect(fired.payload.run.occurrenceKey).toBe("manual:cmd-automation-run-now");
        expect(fired.payload.run.outcome).toBe("manual");
        // Manual runs never advance the schedule.
        expect(fired.payload.nextFireAt).toBe(FUTURE_FIRE);
        expect(fired.payload.state).toBe("active");
      }
    }),
  );

  it.effect("rejects run-now on a deleted automation or a deleted thread", () =>
    Effect.gen(function* () {
      const deleted = yield* decideOrchestrationCommand({
        command: {
          type: "automation.run-now",
          commandId: CommandId.make("cmd-automation-run-deleted"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ deletedAt: NOW, nextFireAt: null })],
        }),
      }).pipe(Effect.flip);
      expect(deleted._tag).toBe("OrchestrationCommandInvariantError");

      const threadGone = yield* decideOrchestrationCommand({
        command: {
          type: "automation.run-now",
          commandId: CommandId.make("cmd-automation-run-thread-gone"),
          automationId: AutomationId.make("automation-1"),
        },
        readModel: makeReadModel({
          thread: makeThread({ deletedAt: NOW }),
          automations: [makeAutomation()],
        }),
      }).pipe(Effect.flip);
      expect(threadGone._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("fires a due once automation to completion", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "automation.fired",
          commandId: CommandId.make("cmd-automation-fired"),
          automationId: AutomationId.make("automation-1"),
          occurrenceKey: FUTURE_FIRE,
          firedAt: FUTURE_FIRE,
          outcome: "ran",
        },
        readModel: makeReadModel({ automations: [makeAutomation()] }),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("automation.fired");
      if (events[0]?.type === "automation.fired") {
        expect(events[0].payload.state).toBe("completed");
        expect(events[0].payload.nextFireAt).toBe(null);
        expect(events[0].payload.run.outcome).toBe("ran");
      }
    }),
  );

  it.effect("fires a due daily automation and advances the schedule", () =>
    Effect.gen(function* () {
      const slot = "1970-01-01T09:00:00.000Z";
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "automation.fired",
          commandId: CommandId.make("cmd-automation-fired-daily"),
          automationId: AutomationId.make("automation-1"),
          occurrenceKey: slot,
          firedAt: slot,
          outcome: "missed-then-ran",
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ schedule: DAILY, nextFireAt: slot })],
        }),
      });
      const events = Array.isArray(event) ? event : [event];
      if (events[0]?.type === "automation.fired") {
        expect(events[0].payload.state).toBe("active");
        expect(events[0].payload.nextFireAt).toBe("1970-01-02T09:00:00.000Z");
        expect(events[0].payload.run.outcome).toBe("missed-then-ran");
      } else {
        expect.unreachable("expected automation.fired");
      }
    }),
  );

  it.effect("rejects duplicate, stale, and paused firings", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel({
        automations: [
          makeAutomation({
            nextFireAt: FUTURE_FIRE,
            runs: [
              {
                occurrenceKey: "manual:cmd-earlier",
                threadId: ThreadId.make("thread-1"),
                firedAt: NOW,
                outcome: "manual",
              },
            ],
          }),
        ],
      });
      const duplicate = yield* decideOrchestrationCommand({
        command: {
          type: "automation.fired",
          commandId: CommandId.make("cmd-automation-dup"),
          automationId: AutomationId.make("automation-1"),
          occurrenceKey: "manual:cmd-earlier",
          firedAt: NOW,
          outcome: "manual",
        },
        readModel,
      }).pipe(Effect.flip);
      expect(duplicate._tag).toBe("OrchestrationCommandInvariantError");

      // The stored slot moved on (a reschedule landed first): the stale
      // occurrence must not fire.
      const stale = yield* decideOrchestrationCommand({
        command: {
          type: "automation.fired",
          commandId: CommandId.make("cmd-automation-stale"),
          automationId: AutomationId.make("automation-1"),
          occurrenceKey: PAST_FIRE,
          firedAt: FUTURE_FIRE,
          outcome: "ran",
        },
        readModel,
      }).pipe(Effect.flip);
      expect(stale._tag).toBe("OrchestrationCommandInvariantError");

      const paused = yield* decideOrchestrationCommand({
        command: {
          type: "automation.fired",
          commandId: CommandId.make("cmd-automation-paused-fire"),
          automationId: AutomationId.make("automation-1"),
          occurrenceKey: FUTURE_FIRE,
          firedAt: FUTURE_FIRE,
          outcome: "ran",
        },
        readModel: makeReadModel({
          automations: [makeAutomation({ state: "paused", nextFireAt: null })],
        }),
      }).pipe(Effect.flip);
      expect(paused._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
