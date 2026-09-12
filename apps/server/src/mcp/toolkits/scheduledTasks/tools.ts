import {
  AutomationId,
  AutomationRunOutcome,
  AutomationSchedule,
  AutomationState,
  IsoDateTime,
  McpCapabilityUnavailableError,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  OrchestrationEngine.OrchestrationEngineService,
  ProjectionSnapshotQuery.ProjectionSnapshotQuery,
];

export class ScheduledTaskNotFoundError extends Schema.TaggedError<ScheduledTaskNotFoundError>()(
  "ScheduledTaskNotFoundError",
  {
    automationId: AutomationId,
  },
) {
  override get message(): string {
    return `No scheduled task '${this.automationId}' exists in this thread's project. Call list_scheduled_tasks to see this project's tasks.`;
  }
}

export class ScheduledTaskCreateFailedError extends Schema.TaggedError<ScheduledTaskCreateFailedError>()(
  "ScheduledTaskCreateFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Creating the scheduled task failed. The schedule may be invalid (a one-off time must be in the future, timezones must be IANA names).";
  }
}

export class ScheduledTaskUpdateFailedError extends Schema.TaggedError<ScheduledTaskUpdateFailedError>()(
  "ScheduledTaskUpdateFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Updating the scheduled task failed.";
  }
}

export class ScheduledTaskPauseFailedError extends Schema.TaggedError<ScheduledTaskPauseFailedError>()(
  "ScheduledTaskPauseFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Pausing the scheduled task failed.";
  }
}

export class ScheduledTaskResumeFailedError extends Schema.TaggedError<ScheduledTaskResumeFailedError>()(
  "ScheduledTaskResumeFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Resuming the scheduled task failed. A one-off task whose time passed cannot be resumed; delete it instead.";
  }
}

export class ScheduledTaskDeleteFailedError extends Schema.TaggedError<ScheduledTaskDeleteFailedError>()(
  "ScheduledTaskDeleteFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Deleting the scheduled task failed.";
  }
}

export class ScheduledTaskRunFailedError extends Schema.TaggedError<ScheduledTaskRunFailedError>()(
  "ScheduledTaskRunFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Running the scheduled task now failed.";
  }
}

export class ScheduledTaskListFailedError extends Schema.TaggedError<ScheduledTaskListFailedError>()(
  "ScheduledTaskListFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Listing scheduled tasks failed.";
  }
}

export const ScheduledTaskToolError = Schema.Union([
  McpCapabilityUnavailableError,
  ScheduledTaskNotFoundError,
  ScheduledTaskCreateFailedError,
  ScheduledTaskUpdateFailedError,
  ScheduledTaskPauseFailedError,
  ScheduledTaskResumeFailedError,
  ScheduledTaskDeleteFailedError,
  ScheduledTaskRunFailedError,
  ScheduledTaskListFailedError,
]);
export type ScheduledTaskToolError = typeof ScheduledTaskToolError.Type;

const ScheduledTaskScheduleInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("once"),
    at: IsoDateTime.annotate({
      description: "ISO instant in the future, for example 2026-09-20T09:00:00.000Z.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("daily"),
    time: TrimmedNonEmptyString.annotate({
      description: "Wall-clock time as HH:MM (24h), for example 09:00.",
    }),
    timezone: TrimmedNonEmptyString.annotate({
      description:
        "IANA timezone, for example America/New_York. The task fires at that wall-clock time, daylight saving included.",
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    time: TrimmedNonEmptyString.annotate({
      description: "Wall-clock time as HH:MM (24h), for example 09:00.",
    }),
    weekday: Schema.Int.annotate({
      description: "Weekday, 0=Sunday through 6=Saturday.",
    }),
    timezone: TrimmedNonEmptyString.annotate({
      description: "IANA timezone, for example America/New_York.",
    }),
  }),
]);

const CreateScheduledTaskInput = Schema.Struct({
  title: TrimmedNonEmptyString.annotate({
    description: "Short title shown in the Scheduled tasks list, for example 'Morning brief'.",
  }),
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "The exact prompt the agent runs unattended on every firing. Write it self-contained: the run starts a fresh turn with no conversation memory beyond the thread history.",
  }),
  schedule: ScheduledTaskScheduleInput,
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Project the task runs in. Defaults to this thread's project; pass another id only to schedule explicitly elsewhere on this machine.",
    }),
  ),
  thread: Schema.optional(
    Schema.Literals(["current", "new"]).annotate({
      description:
        "Which thread the runs live in. 'current' (default) reuses this thread: no extra chat is created and the scheduled prompts appear right here. 'new' mints a dedicated thread for the task, which runs on full access and settles itself after each run.",
    }),
  ),
});

const UpdateScheduledTaskInput = Schema.Struct({
  automationId: AutomationId.annotate({
    description: "Task id from list_scheduled_tasks or create_scheduled_task.",
  }),
  title: Schema.optional(TrimmedNonEmptyString),
  prompt: Schema.optional(TrimmedNonEmptyString),
  schedule: Schema.optional(ScheduledTaskScheduleInput),
});

const ScheduledTaskRefInput = Schema.Struct({
  automationId: AutomationId.annotate({
    description: "Task id from list_scheduled_tasks or create_scheduled_task.",
  }),
});

const ScheduledTaskSummary = Schema.Struct({
  automationId: AutomationId,
  projectId: ProjectId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  state: AutomationState,
  schedule: AutomationSchedule,
  nextFireAt: Schema.NullOr(IsoDateTime),
  lastFiredAt: Schema.NullOr(IsoDateTime),
  runCount: Schema.Number,
  lastOutcome: Schema.NullOr(AutomationRunOutcome),
});
export type ScheduledTaskSummary = typeof ScheduledTaskSummary.Type;

const CreateScheduledTaskTool = Tool.make("create_scheduled_task", {
  description:
    "Schedule an agent run for later: once, daily, or weekly. By default the prompt runs inside THIS thread on its next firings — no extra chat is created. Pass thread:'new' for a dedicated thread instead, which runs on full access and settles itself after each run. Prefer this over telling the user to come back later. Only use it when the user asks for repetition ('every day', 'remind me', 'keep doing this'), or after offering ('want me to schedule this daily?') and hearing yes. Never invent schedules the user did not ask for or agree to.",
  parameters: CreateScheduledTaskInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create scheduled task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  description:
    "List this thread's project's scheduled tasks with their state, schedule, next firing, and run counts. Call it before pausing, resuming, editing, deleting, or running a task you did not just create, so you use a live task id.",
  success: Schema.Struct({ tasks: Schema.Array(ScheduledTaskSummary) }),
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Edit a scheduled task's title, prompt, or schedule. A paused task keeps its paused state; rescheduling an active task recomputes its next firing.",
  parameters: UpdateScheduledTaskInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update scheduled task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PauseScheduledTaskTool = Tool.make("pause_scheduled_task", {
  description: "Pause a scheduled task. It keeps its history and can be resumed later.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Pause scheduled task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ResumeScheduledTaskTool = Tool.make("resume_scheduled_task", {
  description: "Resume a paused scheduled task, recomputing its next firing from now.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Resume scheduled task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Delete a scheduled task. Its thread and run history stay readable; only the schedule goes away.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete scheduled task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RunScheduledTaskNowTool = Tool.make("run_scheduled_task_now", {
  description:
    "Run a scheduled task immediately, outside its schedule. The manual run never moves the next scheduled firing.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run scheduled task now")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ScheduledTasksToolkit = Toolkit.make(
  CreateScheduledTaskTool,
  ListScheduledTasksTool,
  UpdateScheduledTaskTool,
  PauseScheduledTaskTool,
  ResumeScheduledTaskTool,
  DeleteScheduledTaskTool,
  RunScheduledTaskNowTool,
);
