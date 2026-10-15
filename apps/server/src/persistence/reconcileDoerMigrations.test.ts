import { it, expect, describe } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import LegacyAutomations from "./Migrations/051_ProjectionAutomations.ts";
import LegacyDedicated from "./Migrations/052_ProjectionAutomationsDedicatedThread.ts";
import MessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import TitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import FilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettle from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Memories from "./Migrations/057_DoerMemories.ts";
import DoerLegacySchedules from "./DoerLegacySchedules.ts";

const seedAutomations = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
  VALUES ('thread', 'project', 'Reminder', '{"instanceId":"opencode","model":"opencode/big-pickle"}', 'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
  for (const [id, schedule, state] of [
    ["daily", '{"kind":"daily","time":"09:00","timezone":"Asia/Kolkata"}', "active"],
    ["once", '{"kind":"once","at":"2026-10-12T00:00:00.000Z"}', "paused"],
  ]) {
    yield* sql`INSERT INTO projection_automations (automation_id, project_id, thread_id, title, prompt, schedule_json, state, next_fire_at, runs_json, created_at, updated_at)
    VALUES (${id}, 'project', 'thread', 'Reminder', 'Hello', ${schedule}, ${state}, '2026-10-12T00:00:00.000Z', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
  }
});

describe("Doer upgrade", () => {
  it.effect("reconciles shifted migration ids and imports schedules once", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });
      const legacy = [
        ["ProjectionAutomations", LegacyAutomations],
        ["ProjectionAutomationsDedicatedThread", LegacyDedicated],
        ["ProjectionThreadMessageContext", MessageContext],
        ["ProjectionThreadTitleState", TitleState],
        ["PullRequestFilesViewed", FilesViewed],
        ["ProjectionThreadsAutoSettleDisabledAt", AutoSettle],
        ["DoerMemories", Memories],
      ] as const;
      for (const [index, [name, migration]] of legacy.entries()) {
        yield* migration;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${index + 51}, ${name})`;
      }
      yield* seedAutomations;
      yield* sql`INSERT INTO doer_memories VALUES ('memory', 'about-you', NULL, 'My preference', 'thread', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      const executed = yield* runMigrations();
      expect(executed.slice(-2)).toEqual([
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
      ]);
      // The canonical return carries no fork entry: the import tracks itself
      // in doer_schema_migrations.
      expect(executed.every(([id]) => id <= 62)).toBe(true);
      expect(yield* runMigrations()).toEqual([]);
      const rows = yield* sql<{
        task_id: string;
        schedule_json: string;
        enabled: number;
      }>`SELECT task_id, schedule_json, enabled FROM scheduled_tasks ORDER BY task_id`;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ task_id: "daily", enabled: 1 });
      expect(JSON.parse(rows[0]!.schedule_json)).toEqual({
        type: "fixed_time",
        timeOfDay: "09:00",
        timezone: "Asia/Kolkata",
      });
      expect(rows[1]).toMatchObject({ task_id: "once", enabled: 0 });
      expect(JSON.parse(rows[1]!.schedule_json).onceAt).toBe("2026-10-12T00:00:00.000Z");
      expect(yield* sql`SELECT * FROM doer_memories`).toHaveLength(1);
      expect(yield* sql`SELECT migration_id, name FROM doer_schema_migrations`).toEqual([
        { migration_id: 1, name: "LegacySchedules" },
      ]);
      expect(yield* sql`SELECT * FROM doer_legacy_migration_history`).toHaveLength(7);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 55`).toEqual([
        { name: "OrchestrationV2" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("moves a recorded 61 DoerLegacySchedules aside so upstream 61/62 run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // Simulate a database written by a Doer release: canonical schema
      // through 60 plus the schedule import recorded at 61.
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* LegacyAutomations;
      yield* LegacyDedicated;
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('thread', 'project', 'Reminder', '{"instanceId":"opencode","model":"opencode/big-pickle"}', 'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_automations (automation_id, project_id, thread_id, title, prompt, schedule_json, state, next_fire_at, runs_json, created_at, updated_at)
      VALUES ('daily', 'project', 'thread', 'Reminder', 'Hello', '{"kind":"daily","time":"09:00","timezone":"Asia/Kolkata"}', 'active', '2026-10-12T00:00:00.000Z', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* DoerLegacySchedules;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (61, 'DoerLegacySchedules')`;
      yield* sql`INSERT INTO doer_memories VALUES ('memory', 'about-you', NULL, 'My preference', 'thread', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;

      const executed = yield* runMigrations();
      expect(executed).toEqual([
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
      ]);
      expect(yield* runMigrations()).toEqual([]);

      // The completed import transferred to the fork ledger instead of
      // re-running: the one task and the one memory are exactly what the Doer
      // release had written.
      expect(yield* sql`SELECT task_id, enabled FROM scheduled_tasks`).toEqual([
        { task_id: "daily", enabled: 1 },
      ]);
      expect(yield* sql`SELECT * FROM doer_memories`).toHaveLength(1);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pull_request_review_guides'`,
      ).toHaveLength(1);
      const history = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= 61 ORDER BY migration_id`;
      expect(history).toEqual([
        { migration_id: 61, name: "PullRequestReviewGuides" },
        { migration_id: 62, name: "ThreadFailureLookupIndex" },
      ]);
      expect(yield* sql`SELECT migration_id, name FROM doer_schema_migrations`).toEqual([
        { migration_id: 1, name: "LegacySchedules" },
      ]);
      expect(yield* sql`SELECT migration_id, name FROM doer_legacy_migration_history`).toEqual([
        { migration_id: 61, name: "DoerLegacySchedules" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("creates memories and an empty schedule import on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const executed = yield* runMigrations();
      expect(executed.slice(-2)).toEqual([
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
      ]);
      const history = yield* sql<{
        migration_id: number;
        name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
      expect(history.map((row) => [row.migration_id, row.name] as const)).toEqual(
        migrationManifest,
      );
      // Pure upstream and fresh databases get the memories table too, with no
      // schedules to import.
      expect(yield* sql`SELECT * FROM doer_memories`).toEqual([]);
      expect(yield* sql`SELECT * FROM scheduled_tasks`).toEqual([]);
      expect(yield* sql`SELECT migration_id, name FROM doer_schema_migrations`).toEqual([
        { migration_id: 1, name: "LegacySchedules" },
      ]);
      expect(yield* runMigrations()).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("does not run the Doer import for a partial range", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('doer_schema_migrations', 'doer_memories')`,
      ).toEqual([]);
      const executed = yield* runMigrations();
      expect(executed.slice(-2)).toEqual([
        [61, "PullRequestReviewGuides"],
        [62, "ThreadFailureLookupIndex"],
      ]);
      expect(yield* sql`SELECT migration_id, name FROM doer_schema_migrations`).toEqual([
        { migration_id: 1, name: "LegacySchedules" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses an unknown migration at a canonical V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (61, 'PullRequestReviewGuides'), (62, 'UnknownForkMigration')
      `;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const exit = yield* Effect.exit(runMigrations());
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain(
        "62_ThreadFailureLookupIndex (recorded: UnknownForkMigration)",
      );
      expect(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`).toEqual(before);
      expect(
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'doer_schema_migrations'`,
      ).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a Doer 61 row paired with unexpected later history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (61, 'DoerLegacySchedules'), (62, 'UnknownForkMigration')
      `;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const exit = yield* Effect.exit(runMigrations());
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("Cannot upgrade Doer with unexpected migration history.");
      expect(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`).toEqual(before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses an unexpected fork ledger instead of skipping it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`INSERT INTO doer_schema_migrations (migration_id, name) VALUES (2, 'FutureForkMigration')`;
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;

      const exit = yield* Effect.exit(runMigrations());
      expect(Exit.isFailure(exit)).toBe(true);
      expect(String(exit)).toContain("Cannot upgrade Doer with unexpected migration history.");
      expect(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`).toEqual(before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
