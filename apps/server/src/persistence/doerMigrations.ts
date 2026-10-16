import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import DoerLegacySchedules from "./DoerLegacySchedules.ts";

// Fork-local imports live outside the canonical effect_sql_migrations ids so a
// future upstream migration can never collide with them. They run after the
// canonical migrations and track themselves in doer_schema_migrations.
export const DOER_LEGACY_SCHEDULES_ID = 1;
export const DOER_LEGACY_SCHEDULES_NAME = "LegacySchedules";

export const ensureDoerSchemaMigrations = Effect.fn("ensureDoerSchemaMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS doer_schema_migrations (
      migration_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `;
});

/**
 * Run the fork-local Doer import once. Idempotent (the import uses
 * IF NOT EXISTS / OR IGNORE) and transactional, so an interrupted run can be
 * retried safely. Fails closed on an unexpected fork ledger instead of
 * skipping it. Returns true when the import ran.
 */
export const runDoerMigrations = Effect.fn("runDoerMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* ensureDoerSchemaMigrations();
      const recorded = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM doer_schema_migrations`;
      if (
        recorded.some(
          (row) =>
            row.migration_id !== DOER_LEGACY_SCHEDULES_ID ||
            row.name !== DOER_LEGACY_SCHEDULES_NAME,
        )
      ) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade Doer with unexpected migration history.",
        });
      }
      if (recorded.length > 0) return false;
      yield* DoerLegacySchedules.pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            new Migrator.MigrationError({
              kind: "Failed",
              message: "Could not import Doer schedules from the legacy database.",
              cause,
            }),
        }),
      );
      yield* sql`INSERT INTO doer_schema_migrations (migration_id, name) VALUES (${DOER_LEGACY_SCHEDULES_ID}, ${DOER_LEGACY_SCHEDULES_NAME})`;
      return true;
    }),
  );
});
