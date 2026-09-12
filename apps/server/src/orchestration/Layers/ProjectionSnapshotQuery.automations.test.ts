import { AutomationId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const NOW = "2026-09-18T12:00:00.000Z";
const SLOT = "2026-09-18T09:00:00.000Z";

const snapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function insertAutomation(input: {
  readonly automationId: string;
  readonly state: string;
  readonly nextFireAt: string | null;
  readonly deletedAt?: string | null;
  readonly lastFiredAt?: string | null;
}) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_automations (
        automation_id, project_id, thread_id, title, prompt, schedule_json,
        state, next_fire_at, last_fired_at, runs_json,
        created_at, updated_at, deleted_at
      )
      VALUES (
        ${input.automationId}, 'project-1', ${`thread-for-${input.automationId}`},
        ${`Automation ${input.automationId}`}, 'Summarize overnight activity.',
        '{"kind":"daily","time":"09:00","timezone":"UTC"}',
        ${input.state}, ${input.nextFireAt}, ${input.lastFiredAt ?? null}, '[]',
        '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', ${input.deletedAt ?? null}
      )
    `;
  });
}

snapshotLayer("ProjectionSnapshotQuery automations", (it) => {
  it.effect("reads automations across the command, shell, and scheduler queries", () =>
    Effect.gen(function* () {
      const snapshots = yield* ProjectionSnapshotQuery;
      yield* insertAutomation({
        automationId: "automation-due",
        state: "active",
        nextFireAt: SLOT,
      });
      yield* insertAutomation({
        automationId: "automation-future",
        state: "active",
        nextFireAt: "2026-09-19T09:00:00.000Z",
      });
      yield* insertAutomation({
        automationId: "automation-paused",
        state: "paused",
        nextFireAt: null,
      });
      yield* insertAutomation({
        automationId: "automation-gone",
        state: "active",
        nextFireAt: null,
        deletedAt: NOW,
      });
      yield* insertAutomation({
        automationId: "automation-fired",
        state: "active",
        nextFireAt: "2026-09-19T09:00:00.000Z",
        lastFiredAt: "2026-09-18T09:05:00.000Z",
      });

      // The command read model carries every row (the decider needs
      // tombstones for idempotent deletes).
      const commandModel = yield* snapshots.getCommandReadModel();
      assert.deepStrictEqual(
        (commandModel.automations ?? []).map((automation) => automation.id).sort(),
        [
          "automation-due",
          "automation-fired",
          "automation-future",
          "automation-gone",
          "automation-paused",
        ],
      );

      // The shell snapshot only carries live rows.
      const shell = yield* snapshots.getShellSnapshot();
      assert.deepStrictEqual((shell.automations ?? []).map((automation) => automation.id).sort(), [
        "automation-due",
        "automation-fired",
        "automation-future",
        "automation-paused",
      ]);
      const due = (shell.automations ?? []).find(
        (automation) => automation.id === "automation-due",
      );
      assert.strictEqual(due?.prompt, "Summarize overnight activity.");
      assert.deepStrictEqual(due?.schedule, { kind: "daily", time: "09:00", timezone: "UTC" });

      // The scheduler sweep only sees active rows at or past their slot.
      const sweep = yield* snapshots.listDueAutomations({ nowIso: NOW });
      assert.deepStrictEqual(
        sweep.map((automation) => automation.id),
        ["automation-due"],
      );
      const emptySweep = yield* snapshots.listDueAutomations({
        nowIso: "2026-09-01T00:00:00.000Z",
      });
      assert.deepStrictEqual(emptySweep, []);

      // Settle candidates are fired rows past the grace cutoff.
      const candidates = yield* snapshots.listSettleCandidateAutomations({ firedBeforeIso: NOW });
      assert.deepStrictEqual(
        candidates.map((automation) => automation.id),
        ["automation-fired"],
      );
      const noCandidates = yield* snapshots.listSettleCandidateAutomations({
        firedBeforeIso: "2026-09-01T00:00:00.000Z",
      });
      assert.deepStrictEqual(noCandidates, []);

      const byId = yield* snapshots.getAutomationById(AutomationId.make("automation-due"));
      assert.isTrue(Option.isSome(byId));
      const missing = yield* snapshots.getAutomationById(AutomationId.make("automation-missing"));
      assert.isTrue(Option.isNone(missing));
    }),
  );
});
