import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Migration 057: explicit saved memories ("What Doer remembers").
 *
 * One row per memory. Row-level INSERT/UPDATE/DELETE keeps concurrent
 * save/update/delete operations safe — nothing ever rewrites a whole JSON
 * document. About-you rows carry a null project_id; Space rows carry the
 * authoritative project id.
 */
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
