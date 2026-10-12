import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Migrator from "effect/sql/Migrator";
import MessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import TitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import FilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettle from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";

// Doer used 51/52 for reminders and shifted upstream 51–54 to 53–56.
// Archive that ledger before assigning upstream its original ids. Both changes
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
      if (!rows.some((row) => row.migration_id === 51 && row.name === "ProjectionAutomations"))
        return;
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
    }),
  );
});
