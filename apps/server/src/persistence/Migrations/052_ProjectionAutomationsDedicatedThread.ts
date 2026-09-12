import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_automations)
  `;
  // Pre-flag rows were all minted for their automation: backfill dedicated.
  if (!columns.some((column) => column.name === "dedicated_thread")) {
    yield* sql`
      ALTER TABLE projection_automations
      ADD COLUMN dedicated_thread INTEGER NOT NULL DEFAULT 1
    `;
  }
});
