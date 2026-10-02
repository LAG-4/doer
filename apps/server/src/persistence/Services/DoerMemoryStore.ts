/**
 * DoerMemoryStore - Persistence interface for explicit saved memories.
 *
 * One row per memory; every mutation touches a single row by id so
 * concurrent save/update/delete operations cannot clobber each other.
 * About-you rows are owner-scoped (null project id) on this server only;
 * Space rows are keyed by the authoritative project id.
 *
 * @module DoerMemoryStore
 */
import type { DoerMemory, DoerMemoryScope } from "@t3tools/shared/doerMemory";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export class DoerMemoryValidationError extends Schema.TaggedError<DoerMemoryValidationError>()(
  "DoerMemoryValidationError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface DoerMemoryCreateInput {
  readonly id: string;
  readonly scope: DoerMemoryScope;
  /** Required for `space`, absent for `about-you`. */
  readonly projectId: string | null;
  readonly content: string;
  readonly sourceThreadId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DoerMemoryUpdateInput {
  readonly id: string;
  readonly content: string;
  readonly updatedAt: string;
}

export type DoerMemoryStoreError = ProjectionRepositoryError | DoerMemoryValidationError;

export interface DoerMemoryStoreShape {
  /**
   * Insert one row, enforcing the per-bucket cap atomically in a single
   * statement: concurrent saves can never push a bucket past its limit.
   * Returns false when the bucket is already full (nothing was written).
   * Fails on invalid scope/project pairing or content bounds.
   */
  readonly create: (input: DoerMemoryCreateInput) => Effect.Effect<boolean, DoerMemoryStoreError>;
  /** All About-you rows plus one Space's rows, oldest first. */
  readonly listInScope: (input: {
    readonly projectId: string;
  }) => Effect.Effect<ReadonlyArray<DoerMemory>, ProjectionRepositoryError>;
  readonly listAboutYou: () => Effect.Effect<ReadonlyArray<DoerMemory>, ProjectionRepositoryError>;
  readonly listForSpace: (input: {
    readonly projectId: string;
  }) => Effect.Effect<ReadonlyArray<DoerMemory>, ProjectionRepositoryError>;
  readonly getById: (input: {
    readonly id: string;
  }) => Effect.Effect<Option.Option<DoerMemory>, ProjectionRepositoryError>;
  readonly countInScopeBucket: (input: {
    readonly scope: DoerMemoryScope;
    readonly projectId: string | null;
  }) => Effect.Effect<number, ProjectionRepositoryError>;
  /**
   * Update one row's content in a single statement. Returns false when the id
   * is unknown (including when a concurrent delete won the race) — callers
   * must check this instead of assuming a prior read still holds.
   */
  readonly updateById: (
    input: DoerMemoryUpdateInput,
  ) => Effect.Effect<boolean, DoerMemoryStoreError>;
  /**
   * Delete one row in a single statement. Returns false when the id is
   * unknown — callers must check this instead of assuming a prior read.
   */
  readonly deleteById: (input: {
    readonly id: string;
  }) => Effect.Effect<boolean, ProjectionRepositoryError>;
}

/**
 * DoerMemoryStore - Service tag for saved-memory persistence.
 */
export class DoerMemoryStore extends Context.Service<DoerMemoryStore, DoerMemoryStoreShape>()(
  "@lag4/doer-cli/persistence/Services/DoerMemoryStore",
) {}
