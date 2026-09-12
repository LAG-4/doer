import {
  AutomationId,
  AutomationRun,
  AutomationRunOutcome,
  AutomationSchedule,
  AutomationState,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "./Errors.ts";

import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

export const ProjectionAutomation = Schema.Struct({
  automationId: AutomationId,
  projectId: ProjectId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  schedule: AutomationSchedule,
  state: AutomationState,
  dedicatedThread: Schema.Boolean,
  nextFireAt: Schema.NullOr(IsoDateTime),
  lastFiredAt: Schema.NullOr(IsoDateTime),
  runs: Schema.Array(AutomationRun),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionAutomation = typeof ProjectionAutomation.Type;

const IntToBoolean = Schema.Int.pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value !== 0),
      encode: (value) => Effect.succeed(value ? 1 : 0),
    }),
  ),
);

const ProjectionAutomationDbRow = Schema.Struct({
  automationId: AutomationId,
  projectId: ProjectId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  schedule: Schema.fromJsonString(AutomationSchedule),
  state: AutomationState,
  dedicatedThread: IntToBoolean,
  nextFireAt: Schema.NullOr(IsoDateTime),
  lastFiredAt: Schema.NullOr(IsoDateTime),
  runs: Schema.fromJsonString(Schema.Array(AutomationRun)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});

export const GetProjectionAutomationInput = Schema.Struct({
  automationId: AutomationId,
});
export type GetProjectionAutomationInput = typeof GetProjectionAutomationInput.Type;

export const ListDueProjectionAutomationsInput = Schema.Struct({
  nowIso: IsoDateTime,
  limit: Schema.Number,
});
export type ListDueProjectionAutomationsInput = typeof ListDueProjectionAutomationsInput.Type;

export const ListSettleCandidateProjectionAutomationsInput = Schema.Struct({
  /** Only rows whose last firing is at or before this instant. */
  firedBeforeIso: IsoDateTime,
  limit: Schema.Number,
});
export type ListSettleCandidateProjectionAutomationsInput =
  typeof ListSettleCandidateProjectionAutomationsInput.Type;

export const RecordProjectionAutomationRunInput = Schema.Struct({
  automationId: AutomationId,
  occurrenceKey: TrimmedNonEmptyString,
  threadId: ThreadId,
  firedAt: IsoDateTime,
  outcome: AutomationRunOutcome,
});
export type RecordProjectionAutomationRunInput = typeof RecordProjectionAutomationRunInput.Type;

export class ProjectionAutomationRepository extends Context.Service<
  ProjectionAutomationRepository,
  {
    readonly upsert: (row: ProjectionAutomation) => Effect.Effect<void, ProjectionRepositoryError>;
    readonly getById: (
      input: GetProjectionAutomationInput,
    ) => Effect.Effect<Option.Option<ProjectionAutomation>, ProjectionRepositoryError>;
    /** Every row, including deleted ones: the decider needs tombstones for idempotent deletes. */
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<ProjectionAutomation>,
      ProjectionRepositoryError
    >;
    /** Live rows for the shell snapshot: deleted automations never render. */
    readonly listVisible: () => Effect.Effect<
      ReadonlyArray<ProjectionAutomation>,
      ProjectionRepositoryError
    >;
    /** Active rows whose slot came due, oldest slot first. The scheduler sweep reads this. */
    readonly listDue: (
      input: ListDueProjectionAutomationsInput,
    ) => Effect.Effect<ReadonlyArray<ProjectionAutomation>, ProjectionRepositoryError>;
    /**
     * Active rows with a recorded firing at or before the cutoff, oldest
     * firing first. The scheduler sweep settles the ones whose run finished.
     */
    readonly listSettleCandidates: (
      input: ListSettleCandidateProjectionAutomationsInput,
    ) => Effect.Effect<ReadonlyArray<ProjectionAutomation>, ProjectionRepositoryError>;
    readonly recordRun: (
      input: RecordProjectionAutomationRunInput,
    ) => Effect.Effect<void, ProjectionRepositoryError>;
  }
>()("t3/persistence/ProjectionAutomations/ProjectionAutomationRepository") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionAutomationRow = SqlSchema.void({
    Request: ProjectionAutomation,
    execute: (row) => sql`
      INSERT INTO projection_automations (
        automation_id,
        project_id,
        thread_id,
        title,
        prompt,
        schedule_json,
        state,
        dedicated_thread,
        next_fire_at,
        last_fired_at,
        runs_json,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (
        ${row.automationId},
        ${row.projectId},
        ${row.threadId},
        ${row.title},
        ${row.prompt},
        ${JSON.stringify(row.schedule)},
        ${row.state},
        ${row.dedicatedThread ? 1 : 0},
        ${row.nextFireAt},
        ${row.lastFiredAt},
        ${JSON.stringify(row.runs)},
        ${row.createdAt},
        ${row.updatedAt},
        ${row.deletedAt}
      )
      ON CONFLICT (automation_id)
      DO UPDATE SET
        project_id = excluded.project_id,
        thread_id = excluded.thread_id,
        title = excluded.title,
        prompt = excluded.prompt,
        schedule_json = excluded.schedule_json,
        state = excluded.state,
        dedicated_thread = excluded.dedicated_thread,
        next_fire_at = excluded.next_fire_at,
        last_fired_at = excluded.last_fired_at,
        runs_json = excluded.runs_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at
    `,
  });

  const findProjectionAutomationRow = SqlSchema.findOneOption({
    Request: GetProjectionAutomationInput,
    Result: ProjectionAutomationDbRow,
    execute: ({ automationId }) => sql`
      SELECT
        automation_id AS "automationId",
        project_id AS "projectId",
        thread_id AS "threadId",
        title,
        prompt,
        schedule_json AS "schedule",
        state,
        dedicated_thread AS "dedicatedThread",
        next_fire_at AS "nextFireAt",
        last_fired_at AS "lastFiredAt",
        runs_json AS "runs",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_automations
      WHERE automation_id = ${automationId}
    `,
  });

  const listAllProjectionAutomationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionAutomationDbRow,
    execute: () => sql`
      SELECT
        automation_id AS "automationId",
        project_id AS "projectId",
        thread_id AS "threadId",
        title,
        prompt,
        schedule_json AS "schedule",
        state,
        dedicated_thread AS "dedicatedThread",
        next_fire_at AS "nextFireAt",
        last_fired_at AS "lastFiredAt",
        runs_json AS "runs",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_automations
      ORDER BY created_at ASC, automation_id ASC
    `,
  });

  const listVisibleProjectionAutomationRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionAutomationDbRow,
    execute: () => sql`
      SELECT
        automation_id AS "automationId",
        project_id AS "projectId",
        thread_id AS "threadId",
        title,
        prompt,
        schedule_json AS "schedule",
        state,
        dedicated_thread AS "dedicatedThread",
        next_fire_at AS "nextFireAt",
        last_fired_at AS "lastFiredAt",
        runs_json AS "runs",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_automations
      WHERE deleted_at IS NULL
      ORDER BY created_at ASC, automation_id ASC
    `,
  });

  const listDueProjectionAutomationRows = SqlSchema.findAll({
    Request: ListDueProjectionAutomationsInput,
    Result: ProjectionAutomationDbRow,
    execute: ({ nowIso, limit }) => sql`
      SELECT
        automation_id AS "automationId",
        project_id AS "projectId",
        thread_id AS "threadId",
        title,
        prompt,
        schedule_json AS "schedule",
        state,
        dedicated_thread AS "dedicatedThread",
        next_fire_at AS "nextFireAt",
        last_fired_at AS "lastFiredAt",
        runs_json AS "runs",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_automations
      WHERE state = 'active'
        AND next_fire_at IS NOT NULL
        AND next_fire_at <= ${nowIso}
      ORDER BY next_fire_at ASC, automation_id ASC
      LIMIT ${limit}
    `,
  });

  const listSettleCandidateProjectionAutomationRows = SqlSchema.findAll({
    Request: ListSettleCandidateProjectionAutomationsInput,
    Result: ProjectionAutomationDbRow,
    execute: ({ firedBeforeIso, limit }) => sql`
      SELECT
        automation_id AS "automationId",
        project_id AS "projectId",
        thread_id AS "threadId",
        title,
        prompt,
        schedule_json AS "schedule",
        state,
        dedicated_thread AS "dedicatedThread",
        next_fire_at AS "nextFireAt",
        last_fired_at AS "lastFiredAt",
        runs_json AS "runs",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        deleted_at AS "deletedAt"
      FROM projection_automations
      WHERE state = 'active'
        AND last_fired_at IS NOT NULL
        AND last_fired_at <= ${firedBeforeIso}
      ORDER BY last_fired_at ASC, automation_id ASC
      LIMIT ${limit}
    `,
  });

  const recordProjectionAutomationRunRow = SqlSchema.void({
    Request: RecordProjectionAutomationRunInput,
    execute: (input) => sql`
      INSERT OR IGNORE INTO projection_automation_runs (
        automation_id,
        occurrence_key,
        thread_id,
        fired_at,
        outcome
      )
      VALUES (
        ${input.automationId},
        ${input.occurrenceKey},
        ${input.threadId},
        ${input.firedAt},
        ${input.outcome}
      )
    `,
  });

  const upsert: ProjectionAutomationRepository["Service"]["upsert"] = (row) =>
    upsertProjectionAutomationRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAutomationRepository.upsert:query")),
    );

  const getById: ProjectionAutomationRepository["Service"]["getById"] = (input) =>
    findProjectionAutomationRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAutomationRepository.getById:query")),
    );

  const listAll: ProjectionAutomationRepository["Service"]["listAll"] = () =>
    listAllProjectionAutomationRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAutomationRepository.listAll:query")),
    );

  const listVisible: ProjectionAutomationRepository["Service"]["listVisible"] = () =>
    listVisibleProjectionAutomationRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAutomationRepository.listVisible:query")),
    );

  const listDue: ProjectionAutomationRepository["Service"]["listDue"] = (input) =>
    listDueProjectionAutomationRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAutomationRepository.listDue:query")),
    );

  const listSettleCandidates: ProjectionAutomationRepository["Service"]["listSettleCandidates"] = (
    input,
  ) =>
    listSettleCandidateProjectionAutomationRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionAutomationRepository.listSettleCandidates:query"),
      ),
    );

  const recordRun: ProjectionAutomationRepository["Service"]["recordRun"] = (input) =>
    recordProjectionAutomationRunRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAutomationRepository.recordRun:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    listVisible,
    listDue,
    listSettleCandidates,
    recordRun,
  } satisfies ProjectionAutomationRepository["Service"];
});

export const layer = Layer.effect(ProjectionAutomationRepository, make);
