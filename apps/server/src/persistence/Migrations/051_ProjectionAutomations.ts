import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_automations (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      state TEXT NOT NULL,
      next_fire_at TEXT,
      last_fired_at TEXT,
      runs_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_automations_due
    ON projection_automations(state, next_fire_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_automations_project
    ON projection_automations(project_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_automations_thread
    ON projection_automations(thread_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_automation_runs (
      automation_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      fired_at TEXT NOT NULL,
      outcome TEXT NOT NULL,
      PRIMARY KEY (automation_id, occurrence_key)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_automation_runs_thread
    ON projection_automation_runs(thread_id)
  `;
});
