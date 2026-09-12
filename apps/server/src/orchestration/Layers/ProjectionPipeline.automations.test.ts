import {
  AutomationId,
  AutomationRun,
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";

const NOW = "2026-09-18T12:00:00.000Z";
const SLOT = "2026-09-18T09:00:00.000Z";

const decodeRuns = Schema.decodeSync(Schema.fromJsonString(Schema.Array(AutomationRun)));

const testLayer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-pipeline-automations-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

interface AutomationRow {
  readonly automationId: string;
  readonly state: string;
  readonly nextFireAt: string | null;
  readonly lastFiredAt: string | null;
  readonly runsJson: string;
  readonly deletedAt: string | null;
}

interface RunRow {
  readonly automationId: string;
  readonly occurrenceKey: string;
  readonly outcome: string;
}

it.layer(Layer.fresh(testLayer))("automation SQL projection", (it) => {
  it.effect("projects created/paused/fired/deleted into automation tables", () =>
    Effect.gen(function* () {
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const automationId = AutomationId.make("automation-1");

      const created = yield* eventStore.append({
        type: "automation.created",
        eventId: EventId.make("evt-automation-created"),
        aggregateKind: "automation",
        aggregateId: automationId,
        occurredAt: NOW,
        commandId: CommandId.make("cmd-automation-created"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          automationId,
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          title: "Morning brief",
          prompt: "Summarize overnight activity.",
          schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
          nextFireAt: SLOT,
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      yield* projectionPipeline.projectEvent(created);

      const paused = yield* eventStore.append({
        type: "automation.paused",
        eventId: EventId.make("evt-automation-paused"),
        aggregateKind: "automation",
        aggregateId: automationId,
        occurredAt: NOW,
        commandId: CommandId.make("cmd-automation-paused"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { automationId, updatedAt: NOW },
      });
      yield* projectionPipeline.projectEvent(paused);

      const resumed = yield* eventStore.append({
        type: "automation.resumed",
        eventId: EventId.make("evt-automation-resumed"),
        aggregateKind: "automation",
        aggregateId: automationId,
        occurredAt: NOW,
        commandId: CommandId.make("cmd-automation-resumed"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { automationId, nextFireAt: SLOT, updatedAt: NOW },
      });
      yield* projectionPipeline.projectEvent(resumed);

      const fired = yield* eventStore.append({
        type: "automation.fired",
        eventId: EventId.make("evt-automation-fired"),
        aggregateKind: "automation",
        aggregateId: automationId,
        occurredAt: NOW,
        commandId: CommandId.make("cmd-automation-fired"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          automationId,
          run: {
            occurrenceKey: SLOT,
            threadId: ThreadId.make("thread-1"),
            firedAt: NOW,
            outcome: "ran",
          },
          state: "active",
          nextFireAt: "2026-09-19T09:00:00.000Z",
          updatedAt: NOW,
        },
      });
      yield* projectionPipeline.projectEvent(fired);

      const rows = yield* sql<AutomationRow>`
        SELECT
          automation_id AS "automationId",
          state,
          next_fire_at AS "nextFireAt",
          last_fired_at AS "lastFiredAt",
          runs_json AS "runsJson",
          deleted_at AS "deletedAt"
        FROM projection_automations
      `;
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0]?.state, "active");
      assert.strictEqual(rows[0]?.nextFireAt, "2026-09-19T09:00:00.000Z");
      assert.strictEqual(rows[0]?.lastFiredAt, NOW);
      assert.strictEqual(rows[0]?.deletedAt, null);
      assert.deepStrictEqual(decodeRuns(rows[0]?.runsJson ?? "[]"), [
        {
          occurrenceKey: SLOT,
          threadId: ThreadId.make("thread-1"),
          firedAt: NOW,
          outcome: "ran",
        },
      ]);

      const runs = yield* sql<RunRow>`
        SELECT
          automation_id AS "automationId",
          occurrence_key AS "occurrenceKey",
          outcome
        FROM projection_automation_runs
      `;
      assert.deepStrictEqual(runs, [
        { automationId: "automation-1", occurrenceKey: SLOT, outcome: "ran" },
      ]);

      const deleted = yield* eventStore.append({
        type: "automation.deleted",
        eventId: EventId.make("evt-automation-deleted"),
        aggregateKind: "automation",
        aggregateId: automationId,
        occurredAt: NOW,
        commandId: CommandId.make("cmd-automation-deleted"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: { automationId, deletedAt: NOW, updatedAt: NOW },
      });
      yield* projectionPipeline.projectEvent(deleted);

      const afterDelete = yield* sql<AutomationRow>`
        SELECT
          automation_id AS "automationId",
          state,
          next_fire_at AS "nextFireAt",
          last_fired_at AS "lastFiredAt",
          runs_json AS "runsJson",
          deleted_at AS "deletedAt"
        FROM projection_automations
      `;
      assert.strictEqual(afterDelete[0]?.deletedAt, NOW);
      assert.strictEqual(afterDelete[0]?.nextFireAt, null);
    }),
  );
});
