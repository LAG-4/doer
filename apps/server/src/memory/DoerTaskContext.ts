import type {
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

type ReadError = ProjectStore.ProjectStoreV2Error | ProjectionStore.ProjectionStoreV2Error;

/** Resolve fork tools against the same v2 task and folder records as the client. */
export class DoerTaskContext extends Context.Service<
  DoerTaskContext,
  {
    readonly getThreadShellById: (
      id: ThreadId,
    ) => Effect.Effect<
      Option.Option<
        Pick<
          OrchestrationV2ThreadShell,
          "id" | "projectId" | "worktreePath" | "archivedAt" | "deletedAt"
        >
      >,
      ReadError
    >;
    readonly getProjectShellById: (
      id: ProjectId,
    ) => Effect.Effect<Option.Option<OrchestrationProjectShell>, ReadError>;
    readonly getThreadCheckpointContext: (id: ThreadId) => Effect.Effect<
      Option.Option<{
        readonly threadId: ThreadId;
        readonly projectId: ProjectId;
        readonly workspaceRoot: string;
        readonly worktreePath: string | null;
      }>,
      ReadError
    >;
  }
>()("@lag4/doer-cli/memory/DoerTaskContext") {}

const make = Effect.gen(function* () {
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const getThreadShellById = (id: ThreadId) =>
    threads.getThreadShell(id).pipe(Effect.map(Option.fromNullishOr));
  const getThreadCheckpointContext = Effect.fn("DoerTaskContext.getThreadCheckpointContext")(
    function* (id: ThreadId) {
      const thread = yield* getThreadShellById(id);
      if (Option.isNone(thread)) return Option.none();
      const project = yield* projects.getShell(thread.value.projectId);
      if (Option.isNone(project)) return Option.none();
      return Option.some({
        threadId: id,
        projectId: thread.value.projectId,
        workspaceRoot: project.value.workspaceRoot,
        worktreePath: thread.value.worktreePath,
      });
    },
  );
  return DoerTaskContext.of({
    getThreadShellById,
    getProjectShellById: projects.getShell,
    getThreadCheckpointContext,
  });
});
export const layer = Layer.effect(DoerTaskContext, make);
