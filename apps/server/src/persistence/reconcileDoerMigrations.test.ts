import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";
import LegacyAutomations from "./Migrations/051_ProjectionAutomations.ts";
import LegacyDedicated from "./Migrations/052_ProjectionAutomationsDedicatedThread.ts";
import MessageContext from "./Migrations/051_ProjectionThreadMessageContext.ts";
import TitleState from "./Migrations/052_ProjectionThreadTitleState.ts";
import FilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import AutoSettle from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Memories from "./Migrations/057_DoerMemories.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("Doer upgrade", (it) => {
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
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at)
      VALUES ('thread', 'project', 'Reminder', '{"instanceId":"opencode","model":"opencode/big-pickle"}', 'full-access', 'default', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      for (const [id, schedule, state] of [
        ["daily", '{"kind":"daily","time":"09:00","timezone":"Asia/Kolkata"}', "active"],
        ["once", '{"kind":"once","at":"2026-10-12T00:00:00.000Z"}', "paused"],
      ]) {
        yield* sql`INSERT INTO projection_automations (automation_id, project_id, thread_id, title, prompt, schedule_json, state, next_fire_at, runs_json, created_at, updated_at)
        VALUES (${id}, 'project', 'thread', 'Reminder', 'Hello', ${schedule}, ${state}, '2026-10-12T00:00:00.000Z', '[]', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      }
      yield* sql`INSERT INTO doer_memories VALUES ('memory', 'about-you', NULL, 'My preference', 'thread', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`;
      yield* runMigrations();
      yield* runMigrations();
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
      expect(yield* sql`SELECT * FROM doer_legacy_migration_history`).toHaveLength(7);
      expect(yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 55`).toEqual([
        { name: "OrchestrationV2" },
      ]);
    }),
  );
});
