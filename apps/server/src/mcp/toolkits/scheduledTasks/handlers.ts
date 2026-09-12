import {
  AutomationId,
  CommandId,
  ThreadId,
  type Automation,
  type AutomationSchedule,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { computeNextFireAt } from "../../../orchestration/AutomationSchedule.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ScheduledTaskDeleteFailedError,
  ScheduledTaskListFailedError,
  ScheduledTaskNotFoundError,
  ScheduledTaskCreateFailedError,
  ScheduledTaskPauseFailedError,
  ScheduledTaskResumeFailedError,
  ScheduledTaskRunFailedError,
  ScheduledTasksToolkit,
  ScheduledTaskUpdateFailedError,
  type ScheduledTaskSummary,
} from "./tools.ts";

type ScheduledTaskFailure =
  | typeof ScheduledTaskCreateFailedError
  | typeof ScheduledTaskUpdateFailedError
  | typeof ScheduledTaskPauseFailedError
  | typeof ScheduledTaskResumeFailedError
  | typeof ScheduledTaskDeleteFailedError
  | typeof ScheduledTaskRunFailedError
  | typeof ScheduledTaskListFailedError;

/** What the tools report for one task; exported so the shape is testable without a layer. */
export function summarizeScheduledTask(automation: Automation): ScheduledTaskSummary {
  const lastRun = automation.runs.at(-1) ?? null;
  return {
    automationId: automation.id,
    projectId: automation.projectId,
    threadId: automation.threadId,
    title: automation.title,
    state: automation.state,
    schedule: automation.schedule,
    nextFireAt: automation.nextFireAt,
    lastFiredAt: automation.lastFiredAt,
    runCount: automation.runs.length,
    lastOutcome: lastRun?.outcome ?? null,
  };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const newId = <A>(makeId: (uuid: string) => A) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((uuid) => makeId(uuid)),
    );
  const commandId = (tag: string, id: string) =>
    newId((uuid) => CommandId.make(`server:mcp-automation:${tag}:${id}:${uuid}`));

  const dispatchFailure =
    (Failure: ScheduledTaskFailure) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<never, InstanceType<ScheduledTaskFailure>> =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }) as InstanceType<ScheduledTaskFailure>);

  const requireScopeThread = Effect.fn("ScheduledTasksToolkit.requireScopeThread")(function* (
    Failure: ScheduledTaskFailure,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("automations");
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(thread)) {
      return yield* new ScheduledTaskNotFoundError({
        automationId: AutomationId.make("unknown"),
      });
    }
    return { scope, thread: thread.value };
  });

  const requireAutomation = Effect.fn("ScheduledTasksToolkit.requireAutomation")(function* (
    automationId: AutomationId,
    projectId: OrchestrationThreadShell["projectId"],
    Failure: ScheduledTaskFailure,
  ) {
    const automation = yield* snapshots
      .getAutomationById(automationId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(automation) || automation.value.projectId !== projectId) {
      return yield* new ScheduledTaskNotFoundError({ automationId });
    }
    return automation.value;
  });

  const summarizeById = Effect.fn("ScheduledTasksToolkit.summarizeById")(function* (
    automationId: AutomationId,
    Failure: ScheduledTaskFailure,
  ) {
    const automation = yield* snapshots
      .getAutomationById(automationId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(automation)) {
      return yield* new ScheduledTaskNotFoundError({ automationId });
    }
    return summarizeScheduledTask(automation.value);
  });

  return ScheduledTasksToolkit.of({
    create_scheduled_task: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(ScheduledTaskCreateFailedError);
        const projectId = input.projectId ?? thread.projectId;
        const useCurrentThread = (input.thread ?? "current") === "current";
        if (
          useCurrentThread &&
          input.projectId !== undefined &&
          input.projectId !== thread.projectId
        ) {
          return yield* new ScheduledTaskCreateFailedError({
            cause: new Error(
              `This thread lives in project '${thread.projectId}', not '${input.projectId}'. Omit projectId to schedule in this thread, or pass thread:'new' for another project.`,
            ),
          });
        }
        const occurredAt = yield* nowIso;
        const threadId = useCurrentThread ? thread.id : yield* newId(ThreadId.make);
        if (!useCurrentThread) {
          yield* engine
            .dispatch({
              type: "thread.create",
              commandId: yield* commandId("thread", threadId),
              threadId,
              projectId,
              title: input.title,
              modelSelection: thread.modelSelection,
              runtimeMode: "full-access",
              interactionMode: thread.interactionMode,
              branch: null,
              worktreePath: null,
              createdAt: occurredAt,
            })
            .pipe(Effect.catchCause(dispatchFailure(ScheduledTaskCreateFailedError)));
        }
        const automationId = yield* newId(AutomationId.make);
        const nextFireAt = computeNextFireAt(input.schedule as AutomationSchedule, occurredAt);
        yield* engine
          .dispatch({
            type: "automation.create",
            commandId: yield* commandId("create", automationId),
            automationId,
            projectId,
            threadId,
            title: input.title,
            prompt: input.prompt,
            schedule: input.schedule as AutomationSchedule,
            dedicatedThread: !useCurrentThread,
            createdAt: occurredAt,
          })
          .pipe(Effect.catchCause(dispatchFailure(ScheduledTaskCreateFailedError)));
        const summary = yield* summarizeById(automationId, ScheduledTaskCreateFailedError);
        return { ...summary, nextFireAt: summary.nextFireAt ?? nextFireAt };
      }),

    list_scheduled_tasks: () =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(ScheduledTaskListFailedError);
        const automations = yield* snapshots
          .listVisibleAutomations()
          .pipe(Effect.mapError((cause) => new ScheduledTaskListFailedError({ cause })));
        return {
          tasks: automations
            .filter((automation) => automation.projectId === thread.projectId)
            .map(summarizeScheduledTask),
        };
      }),

    update_scheduled_task: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(ScheduledTaskUpdateFailedError);
        yield* requireAutomation(
          input.automationId,
          thread.projectId,
          ScheduledTaskUpdateFailedError,
        );
        yield* engine
          .dispatch({
            type: "automation.update",
            commandId: yield* commandId("update", input.automationId),
            automationId: input.automationId,
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
            ...(input.schedule !== undefined
              ? { schedule: input.schedule as AutomationSchedule }
              : {}),
          })
          .pipe(Effect.catchCause(dispatchFailure(ScheduledTaskUpdateFailedError)));
        return yield* summarizeById(input.automationId, ScheduledTaskUpdateFailedError);
      }),

    pause_scheduled_task: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(ScheduledTaskPauseFailedError);
        yield* requireAutomation(
          input.automationId,
          thread.projectId,
          ScheduledTaskPauseFailedError,
        );
        yield* engine
          .dispatch({
            type: "automation.pause",
            commandId: yield* commandId("pause", input.automationId),
            automationId: input.automationId,
          })
          .pipe(Effect.catchCause(dispatchFailure(ScheduledTaskPauseFailedError)));
        return yield* summarizeById(input.automationId, ScheduledTaskPauseFailedError);
      }),

    resume_scheduled_task: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(ScheduledTaskResumeFailedError);
        yield* requireAutomation(
          input.automationId,
          thread.projectId,
          ScheduledTaskResumeFailedError,
        );
        yield* engine
          .dispatch({
            type: "automation.resume",
            commandId: yield* commandId("resume", input.automationId),
            automationId: input.automationId,
          })
          .pipe(Effect.catchCause(dispatchFailure(ScheduledTaskResumeFailedError)));
        return yield* summarizeById(input.automationId, ScheduledTaskResumeFailedError);
      }),

    delete_scheduled_task: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(ScheduledTaskDeleteFailedError);
        yield* requireAutomation(
          input.automationId,
          thread.projectId,
          ScheduledTaskDeleteFailedError,
        );
        yield* engine
          .dispatch({
            type: "automation.delete",
            commandId: yield* commandId("delete", input.automationId),
            automationId: input.automationId,
          })
          .pipe(Effect.catchCause(dispatchFailure(ScheduledTaskDeleteFailedError)));
        return yield* summarizeById(input.automationId, ScheduledTaskDeleteFailedError);
      }),

    run_scheduled_task_now: (input) =>
      Effect.gen(function* () {
        const { thread } = yield* requireScopeThread(ScheduledTaskRunFailedError);
        yield* requireAutomation(input.automationId, thread.projectId, ScheduledTaskRunFailedError);
        yield* engine
          .dispatch({
            type: "automation.run-now",
            commandId: yield* commandId("run-now", input.automationId),
            automationId: input.automationId,
          })
          .pipe(Effect.catchCause(dispatchFailure(ScheduledTaskRunFailedError)));
        return yield* summarizeById(input.automationId, ScheduledTaskRunFailedError);
      }),
  });
});

export const ScheduledTasksToolkitHandlersLive = ScheduledTasksToolkit.toLayer(make);
