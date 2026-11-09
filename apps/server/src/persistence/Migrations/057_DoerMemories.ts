import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Migration 057: explicit saved memories. One row per memory; null project_id means About-you. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS doer_memories (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      content TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS doer_memories_scope_project_updated_idx
    ON doer_memories (scope, project_id, updated_at)
  `;
});
