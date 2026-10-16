import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import MessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import TitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import FilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettle from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import {
  DOER_LEGACY_SCHEDULES_ID,
  DOER_LEGACY_SCHEDULES_NAME,
  ensureDoerSchemaMigrations,
} from "./doerMigrations.ts";

// Doer used 51/52 for reminders and shifted upstream 51–54 to 53–56.
// Archive that ledger before assigning upstream its original ids. Doer
// releases also recorded the legacy schedule import at 61, which upstream now
// owns (PullRequestReviewGuides; 62 is ThreadFailureLookupIndex). Both changes
// are transactional so an interrupted upgrade can be retried safely.
export const reconcileDoerMigrations = Effect.fn("reconcileDoerMigrations")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`;
      if (tables.length === 0) return;
      const rows = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 51`;
      if (rows.some((row) => row.migration_id === 51 && row.name === "ProjectionAutomations")) {
        const known = new Map([
          [51, "ProjectionAutomations"],
          [52, "ProjectionAutomationsDedicatedThread"],
          [53, "ProjectionThreadMessageContext"],
          [54, "ProjectionThreadTitleState"],
          [55, "PullRequestFilesViewed"],
          [56, "ProjectionThreadsAutoSettleDisabledAt"],
          [57, "DoerMemories"],
        ]);
        if (rows.some((row) => known.get(row.migration_id) !== row.name)) {
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade Doer with unexpected migration history.",
          });
        }
        yield* sql`CREATE TABLE doer_legacy_migration_history AS SELECT * FROM effect_sql_migrations WHERE migration_id >= 51`;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id >= 51`;
        const steps = [
          [51, "ProjectionThreadMessageContext", MessageContext],
          [52, "ProjectionThreadTitleState", TitleState],
          [53, "PullRequestFilesViewed", FilesViewed],
          [54, "ProjectionThreadsAutoSettleDisabledAt", AutoSettle],
        ] as const;
        for (const [id, name, migration] of steps) {
          if (!rows.some((row) => row.name === name)) yield* migration;
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
        }
      }
      // The migrator only runs ids above the highest recorded one, so a stale
      // 61_DoerLegacySchedules row would silently skip the canonical 61/62
      // migrations. Archive and remove it before the V2 assertion runs. The
      // import already wrote its tables, so transfer its completion to the
      // fork ledger: the post-migration Doer import then skips re-running it
      // and the schedules stay exactly as the Doer release left them.
      const later = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 61`;
      if (!later.some((row) => row.migration_id === 61 && row.name === "DoerLegacySchedules"))
        return;
      if (later.some((row) => row.migration_id !== 61 || row.name !== "DoerLegacySchedules")) {
        return yield* new Migrator.MigrationError({
          kind: "BadState",
          message: "Cannot upgrade Doer with unexpected migration history.",
        });
      }
      yield* sql`CREATE TABLE IF NOT EXISTS doer_legacy_migration_history AS SELECT * FROM effect_sql_migrations WHERE 0`;
      yield* sql`INSERT INTO doer_legacy_migration_history SELECT * FROM effect_sql_migrations WHERE migration_id = 61 AND name = 'DoerLegacySchedules'`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 61 AND name = 'DoerLegacySchedules'`;
      yield* ensureDoerSchemaMigrations();
      yield* sql`INSERT OR IGNORE INTO doer_schema_migrations (migration_id, name) VALUES (${DOER_LEGACY_SCHEDULES_ID}, ${DOER_LEGACY_SCHEDULES_NAME})`;
    }),
  );
});
