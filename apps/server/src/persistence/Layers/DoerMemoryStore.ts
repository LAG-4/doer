import {
  DOER_MEMORY_MAX_CONTENT_CHARS,
  DOER_MEMORY_MAX_COUNT_PER_SCOPE,
  DoerMemory,
} from "@t3tools/shared/doerMemory";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError, type PersistenceSqlError } from "../Errors.ts";
import {
  DoerMemoryStore,
  DoerMemoryValidationError,
  type DoerMemoryCreateInput,
  type DoerMemoryStoreShape,
  type DoerMemoryUpdateInput,
} from "../Services/DoerMemoryStore.ts";

const DoerMemoryRow = DoerMemory;

/** Final gate on every write: scope/project pairing plus content bounds. */
const validateWrite = (
  operation: string,
  input: { scope: string; projectId: string | null; content: string; id: string },
): Effect.Effect<void, DoerMemoryValidationError> => {
  const paired =
    input.scope === "about-you"
      ? input.projectId === null
      : input.scope === "space" && input.projectId !== null && input.projectId.trim() !== "";
  if (!paired) {
    return new DoerMemoryValidationError({
      reason: `${operation}: scope '${input.scope}' does not pair with this Space reference.`,
    });
  }
  const content = input.content.trim();
  if (content === "" || content.length > DOER_MEMORY_MAX_CONTENT_CHARS) {
    return new DoerMemoryValidationError({
      reason: `${operation}: memory text must hold 1 to ${DOER_MEMORY_MAX_CONTENT_CHARS} characters.`,
    });
  }
  if (input.id.trim() === "") {
    return new DoerMemoryValidationError({ reason: `${operation}: memory id is required.` });
  }
  return Effect.void;
};

const makeDoerMemoryStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Atomic cap gate: the single statement inserts only when the bucket is
  // below its limit. SQLite serializes writers, so concurrent saves can never
  // push a bucket past its cap — no count-then-create race.
  const createRow = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String,
      scope: Schema.String,
      projectId: Schema.NullOr(Schema.String),
      content: Schema.String,
      sourceThreadId: Schema.String,
      createdAt: Schema.String,
      updatedAt: Schema.String,
      maxCount: Schema.Number,
    }),
    execute: (row) =>
      row.projectId === null
        ? sql`
          INSERT INTO doer_memories (
            id, scope, project_id, content, source_thread_id, created_at, updated_at
          )
          SELECT ${row.id}, ${row.scope}, ${row.projectId}, ${row.content}, ${row.sourceThreadId}, ${row.createdAt}, ${row.updatedAt}
          WHERE (
            SELECT COUNT(*) FROM doer_memories
            WHERE scope = ${row.scope} AND project_id IS NULL
          ) < ${row.maxCount}
        `
        : sql`
          INSERT INTO doer_memories (
            id, scope, project_id, content, source_thread_id, created_at, updated_at
          )
          SELECT ${row.id}, ${row.scope}, ${row.projectId}, ${row.content}, ${row.sourceThreadId}, ${row.createdAt}, ${row.updatedAt}
          WHERE (
            SELECT COUNT(*) FROM doer_memories
            WHERE scope = ${row.scope} AND project_id = ${row.projectId}
          ) < ${row.maxCount}
        `,
  });

  const listAboutYouRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: DoerMemoryRow,
    execute: () => sql`
      SELECT
        id,
        scope,
        project_id AS "projectId",
        content,
        source_thread_id AS "sourceThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM doer_memories
      WHERE scope = 'about-you'
      ORDER BY created_at ASC, id ASC
    `,
  });

  const listForSpaceRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.String }),
    Result: DoerMemoryRow,
    execute: ({ projectId }) => sql`
      SELECT
        id,
        scope,
        project_id AS "projectId",
        content,
        source_thread_id AS "sourceThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM doer_memories
      WHERE scope = 'space' AND project_id = ${projectId}
      ORDER BY created_at ASC, id ASC
    `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Schema.String }),
    Result: DoerMemoryRow,
    execute: ({ id }) => sql`
      SELECT
        id,
        scope,
        project_id AS "projectId",
        content,
        source_thread_id AS "sourceThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM doer_memories
      WHERE id = ${id}
    `,
  });

  const countBucketRows = SqlSchema.findOne({
    Request: Schema.Struct({
      scope: Schema.String,
      projectId: Schema.NullOr(Schema.String),
    }),
    Result: Schema.Struct({ count: Schema.Number }),
    execute: ({ scope, projectId }) =>
      projectId === null
        ? sql`SELECT COUNT(*) AS "count" FROM doer_memories WHERE scope = ${scope} AND project_id IS NULL`
        : sql`SELECT COUNT(*) AS "count" FROM doer_memories WHERE scope = ${scope} AND project_id = ${projectId}`,
  });

  const updateContentById = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String,
      content: Schema.String,
      updatedAt: Schema.String,
    }),
    execute: (row) => sql`
      UPDATE doer_memories
      SET content = ${row.content}, updated_at = ${row.updatedAt}
      WHERE id = ${row.id}
    `,
  });

  const deleteByIdRow = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String }),
    execute: ({ id }) => sql`
      DELETE FROM doer_memories WHERE id = ${id}
    `,
  });

  const changedRows = SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ changed: Schema.Number }),
    execute: () => sql`SELECT changes() AS "changed"`,
  });

  /**
   * Run a single-row write plus its changes() read on one transaction so the
   * affected-row answer belongs to this write even under concurrency. No
   * read-before-write: false means unknown id (or a lost delete race).
   */
  const writeOneRow = <E>(
    operation: string,
    write: Effect.Effect<void, E>,
  ): Effect.Effect<boolean, PersistenceSqlError> =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* write;
          return (yield* changedRows()).changed > 0;
        }),
      )
      .pipe(Effect.mapError(toPersistenceSqlError(`${operation}:query`)));

  const create: DoerMemoryStoreShape["create"] = (input: DoerMemoryCreateInput) =>
    validateWrite("DoerMemoryStore.create", input).pipe(
      Effect.andThen(() =>
        writeOneRow(
          "DoerMemoryStore.create",
          createRow({
            id: input.id,
            scope: input.scope,
            projectId: input.projectId,
            content: input.content,
            sourceThreadId: input.sourceThreadId,
            createdAt: input.createdAt,
            updatedAt: input.updatedAt,
            maxCount: DOER_MEMORY_MAX_COUNT_PER_SCOPE,
          }).pipe(Effect.mapError(toPersistenceSqlError("DoerMemoryStore.create:query"))),
        ),
      ),
    );

  const listAboutYou: DoerMemoryStoreShape["listAboutYou"] = () =>
    listAboutYouRows().pipe(
      Effect.mapError(toPersistenceSqlError("DoerMemoryStore.listAboutYou:query")),
    );

  const listForSpace: DoerMemoryStoreShape["listForSpace"] = (input) =>
    listForSpaceRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("DoerMemoryStore.listForSpace:query")),
    );

  const listInScope: DoerMemoryStoreShape["listInScope"] = (input) =>
    Effect.zip(listAboutYou(), listForSpace(input), { concurrent: true }).pipe(
      Effect.map(([aboutYou, space]) => [...aboutYou, ...space]),
    );

  const getById: DoerMemoryStoreShape["getById"] = (input) =>
    getByIdRow(input).pipe(Effect.mapError(toPersistenceSqlError("DoerMemoryStore.getById:query")));

  const countInScopeBucket: DoerMemoryStoreShape["countInScopeBucket"] = (input) =>
    countBucketRows({ scope: input.scope, projectId: input.projectId }).pipe(
      Effect.map((row) => row.count),
      Effect.mapError(toPersistenceSqlError("DoerMemoryStore.countInScopeBucket:query")),
    );

  const updateById: DoerMemoryStoreShape["updateById"] = (input: DoerMemoryUpdateInput) =>
    getByIdRow({ id: input.id })
      .pipe(Effect.mapError(toPersistenceSqlError("DoerMemoryStore.updateById:query")))
      .pipe(
        Effect.flatMap((existing) => {
          if (existing._tag === "None") {
            return Effect.succeed(false);
          }
          const current = existing.value;
          return validateWrite("DoerMemoryStore.updateById", {
            scope: current.scope,
            projectId: current.projectId,
            content: input.content,
            id: input.id,
          }).pipe(
            Effect.andThen(() =>
              writeOneRow(
                "DoerMemoryStore.updateById",
                updateContentById(input).pipe(
                  Effect.mapError(toPersistenceSqlError("DoerMemoryStore.updateById:query")),
                ),
              ),
            ),
          );
        }),
      );

  const deleteById: DoerMemoryStoreShape["deleteById"] = (input) =>
    writeOneRow(
      "DoerMemoryStore.deleteById",
      deleteByIdRow(input).pipe(
        Effect.mapError(toPersistenceSqlError("DoerMemoryStore.deleteById:query")),
      ),
    );

  return {
    create,
    listInScope,
    listAboutYou,
    listForSpace,
    getById,
    countInScopeBucket,
    updateById,
    deleteById,
  } satisfies DoerMemoryStoreShape;
});

export const DoerMemoryStoreLive = Layer.effect(DoerMemoryStore, makeDoerMemoryStore);
