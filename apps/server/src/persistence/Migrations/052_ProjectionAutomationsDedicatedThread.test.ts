import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import migrateDedicatedThread from "./052_ProjectionAutomationsDedicatedThread.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("052_ProjectionAutomationsDedicatedThread", (it) => {
  it.effect("adds the dedicated flag defaulting existing rows to dedicated", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });

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

      yield* runMigrations({ toMigrationInclusive: 52 });

      const rows = yield* sql<{ readonly dedicatedThread: number }>`
        SELECT dedicated_thread AS "dedicatedThread" FROM projection_automations
      `;
      assert.deepStrictEqual(rows, [{ dedicatedThread: 1 }]);

      // The migration is idempotent: recovery may run it twice.
      yield* migrateDedicatedThread;
      const again = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM projection_automations
      `;
      assert.deepStrictEqual(again, [{ count: 1 }]);
    }),
  );
});
