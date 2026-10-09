import {
  ModelSelection,
  ScheduledTaskSchedule,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import Memories from "./057_DoerMemories.ts";

const LegacySchedule = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("once"), at: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("daily"), time: Schema.String, timezone: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("weekly"),
    time: Schema.String,
    timezone: Schema.String,
    weekday: Schema.Number,
  }),
]);

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* Memories;
  const tables = yield* sql`SELECT name FROM sqlite_master WHERE name = 'projection_automations'`;
  if (tables.length === 0) return;
  const rows = yield* sql<{
    automation_id: string;
    project_id: string;
    thread_id: string;
    title: string;
    prompt: string;
    schedule_json: string;
    state: string;
    next_fire_at: string | null;
    last_fired_at: string | null;
    runs_json: string;
    created_at: string;
    updated_at: string;
    model_selection_json: string;
    runtime_mode: string;
    interaction_mode: string;
    worktree_path: string | null;
  }>`SELECT a.*, t.model_selection_json, t.runtime_mode, t.interaction_mode, t.worktree_path
     FROM projection_automations a JOIN projection_threads t ON t.thread_id = a.thread_id
     WHERE a.deleted_at IS NULL AND t.deleted_at IS NULL`;
  for (const row of rows) {
    const legacy = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(LegacySchedule))(
      row.schedule_json,
    );
    const model = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ModelSelection))(
      row.model_selection_json,
    );
    const runs = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.Unknown)),
    )(row.runs_json);
    const schedule: ScheduledTaskSchedule =
      legacy.kind === "once"
        ? { type: "interval", everyMs: 86400000, onceAt: legacy.at }
        : {
            type: "fixed_time",
            timeOfDay: legacy.time,
            timezone: legacy.timezone,
            ...(legacy.kind === "weekly" ? { weekdays: [legacy.weekday] } : {}),
          };
    const strategy: OrchestrationV2ThreadLaunchWorkspaceStrategy =
      row.worktree_path === null
        ? { type: "root" }
        : { type: "existing_worktree", worktreePath: row.worktree_path };
    const scheduleJson = yield* Schema.encodeEffect(Schema.fromJsonString(ScheduledTaskSchedule))(
      schedule,
    );
    const strategyJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(OrchestrationV2ThreadLaunchWorkspaceStrategy),
    )(strategy);
    const modelJson = yield* Schema.encodeEffect(Schema.fromJsonString(ModelSelection))(model);
    yield* sql`INSERT OR IGNORE INTO scheduled_tasks (
      task_id, title, prompt, enabled, schedule_json, project_id, thread_id, workspace_strategy_json,
      model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at,
      updated_at, next_run_at, last_run_at, last_run_status, last_run_error, run_count
    ) VALUES (${row.automation_id}, ${row.title}, ${row.prompt}, ${row.state === "active" ? 1 : 0},
      ${scheduleJson}, ${row.project_id}, ${row.thread_id}, ${strategyJson},
      ${modelJson}, ${row.runtime_mode}, ${row.interaction_mode}, 'user', 'server',
      ${row.created_at}, ${row.updated_at}, ${row.state === "active" ? row.next_fire_at : null},
      ${row.last_fired_at}, 'never', NULL, ${runs.length})`;
  }
});
