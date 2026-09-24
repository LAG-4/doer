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
    return `No reminder '${this.automationId}' exists in this task's Space. Call list_scheduled_tasks to see this Space's reminders.`;
  }
}

export class ScheduledTaskCreateFailedError extends Schema.TaggedError<ScheduledTaskCreateFailedError>()(
  "ScheduledTaskCreateFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Creating the reminder failed. The schedule may be invalid (a one-off time must be in the future, timezones must be IANA names).";
  }
}

export class ScheduledTaskUpdateFailedError extends Schema.TaggedError<ScheduledTaskUpdateFailedError>()(
  "ScheduledTaskUpdateFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Updating the reminder failed.";
  }
}

export class ScheduledTaskPauseFailedError extends Schema.TaggedError<ScheduledTaskPauseFailedError>()(
  "ScheduledTaskPauseFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Pausing the reminder failed.";
  }
}

export class ScheduledTaskResumeFailedError extends Schema.TaggedError<ScheduledTaskResumeFailedError>()(
  "ScheduledTaskResumeFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Resuming the reminder failed. A one-off reminder whose time passed cannot be resumed; stop it instead.";
  }
}

export class ScheduledTaskDeleteFailedError extends Schema.TaggedError<ScheduledTaskDeleteFailedError>()(
  "ScheduledTaskDeleteFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Stopping the reminder failed.";
  }
}

export class ScheduledTaskRunFailedError extends Schema.TaggedError<ScheduledTaskRunFailedError>()(
  "ScheduledTaskRunFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Running the reminder now failed.";
  }
}

export class ScheduledTaskListFailedError extends Schema.TaggedError<ScheduledTaskListFailedError>()(
  "ScheduledTaskListFailedError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Listing reminders failed.";
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
    description: "Short title shown in the Reminders list, for example 'Morning brief'.",
  }),
  prompt: TrimmedNonEmptyString.annotate({
    description:
      "What the agent does on every firing, written self-contained: the run starts a fresh turn with no memory beyond the task history.",
  }),
  schedule: ScheduledTaskScheduleInput,
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Folder the reminder lives in. Leave unset for general reminders — they live in the default folder. Pass a specific id only when the reminder belongs to a particular folder; find that folder first.",
    }),
  ),
  thread: Schema.optional(
    Schema.Literals(["current", "new"]).annotate({
      description:
        "Which task the runs land in. 'current' (default) runs inside THIS task so the user sees results where they already look: no extra chat is created. 'new' starts a separate task for the reminder, which runs on full access and settles itself after each run.",
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
    "Set up a reminder that runs later: once, every day, or every week. By default it runs inside THIS task so the user sees results where they already look — no extra chat is created. Pass thread:'new' for a separate task instead, which runs on full access and settles itself after each run. Prefer this over telling the user to come back later. Only use it when the user asks for repetition ('every day', 'remind me', 'keep doing this'), or after offering ('Want me to do this every week? You can undo anytime.') and hearing yes. Never invent reminders the user did not ask for or agree to.",
  parameters: CreateScheduledTaskInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create reminder")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  description:
    "List this task's Space's reminders with their state, schedule, next run, and run counts. Call it before pausing, resuming, editing, stopping, or running a reminder you did not just create, so you use a live id.",
  success: Schema.Struct({ tasks: Schema.Array(ScheduledTaskSummary) }),
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "List reminders")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const UpdateScheduledTaskTool = Tool.make("update_scheduled_task", {
  description:
    "Edit a reminder's title, prompt, or schedule. A paused reminder stays paused; rescheduling an active reminder recomputes its next run.",
  parameters: UpdateScheduledTaskInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update reminder")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const PauseScheduledTaskTool = Tool.make("pause_scheduled_task", {
  description: "Pause a reminder. It keeps its history and can be resumed later.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Pause reminder")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ResumeScheduledTaskTool = Tool.make("resume_scheduled_task", {
  description: "Resume a paused reminder, recomputing its next run from now.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Resume reminder")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Stop a reminder. Its task and past results stay readable; only the repetition goes away.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Stop reminder")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const RunScheduledTaskNowTool = Tool.make("run_scheduled_task_now", {
  description:
    "Run a reminder immediately, outside its schedule. The manual run never moves the next scheduled run.",
  parameters: ScheduledTaskRefInput,
  success: ScheduledTaskSummary,
  failure: ScheduledTaskToolError,
  dependencies,
})
  .annotate(Tool.Title, "Run reminder now")
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
