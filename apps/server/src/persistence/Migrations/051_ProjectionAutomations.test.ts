import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateAutomations from "./051_ProjectionAutomations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("051_ProjectionAutomations", (it) => {
  it.effect("creates the automation and run tables with due indexes", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });

      const before = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'projection_automation%'
      `;
      assert.deepEqual(before, []);

      yield* runMigrations({ toMigrationInclusive: 51 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'projection_automation%' ORDER BY name
      `;
      assert.deepEqual(
        tables.map((row) => row.name),
        ["projection_automation_runs", "projection_automations"],
      );

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_projection_automation%' ORDER BY name
      `;
      assert.deepEqual(
        indexes.map((row) => row.name),
        [
          "idx_projection_automation_runs_thread",
          "idx_projection_automations_due",
          "idx_projection_automations_project",
          "idx_projection_automations_thread",
        ],
      );

      // The migration is idempotent: recovery may run it twice.
      yield* migrateAutomations;
      const again = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM projection_automations
      `;
      assert.deepEqual(again, [{ count: 0 }]);

      // The due index serves the scheduler sweep predicate.
      yield* sql`
        INSERT INTO projection_automations (
          automation_id, project_id, thread_id, title, prompt, schedule_json,
          state, next_fire_at, last_fired_at, runs_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          'automation-1', 'project-1', 'thread-1', 'Morning brief', 'Summarize',
          '{"kind":"daily","time":"09:00","timezone":"UTC"}',
          'active', '2026-09-18T09:00:00.000Z', NULL, '[]',
          '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', NULL
        )
      `;
      const due = yield* sql<{ readonly automationId: string }>`
        SELECT automation_id AS "automationId" FROM projection_automations
        WHERE state = 'active' AND next_fire_at <= '2026-09-18T10:00:00.000Z'
      `;
      assert.deepEqual(due, [{ automationId: "automation-1" }]);

      // One run per occurrence: the occurrence key is unique per automation.
      yield* sql`
        INSERT INTO projection_automation_runs (
          automation_id, occurrence_key, thread_id, fired_at, outcome
        ) VALUES (
          'automation-1', '2026-09-18T09:00:00.000Z', 'thread-1',
          '2026-09-18T09:00:05.000Z', 'ran'
        )
      `;
      const duplicate = yield* sql`
        INSERT INTO projection_automation_runs (
          automation_id, occurrence_key, thread_id, fired_at, outcome
        ) VALUES (
          'automation-1', '2026-09-18T09:00:00.000Z', 'thread-1',
          '2026-09-18T09:00:05.000Z', 'ran'
        )
      `.pipe(Effect.flip);
      assert.isTrue(duplicate._tag === "SqlError");
    }),
  );
});
