import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_CODEX_MODEL, ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessHomeDirectory } from "@t3tools/shared/hostProcess";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { resolveInboxWelcomeTargets } from "./InboxProvisioning.ts";
import { INBOX_PROJECT_TITLE } from "./InboxWorkspace.ts";

const unusedProjection = {
  getUserInputActivity: () => Effect.die("unused"),
  getCommandReadModel: () => Effect.die("unused"),
  getSnapshot: () => Effect.die("unused"),
  getShellSnapshot: () => Effect.die("unused"),
  getArchivedShellSnapshot: () => Effect.die("unused"),
  getSnapshotSequence: () => Effect.die("unused"),
  getCounts: () => Effect.die("unused"),
  getEventReplayStats: () => Effect.die("unused"),
  getProjectShells: () => Effect.die("unused"),
  getProjectShellById: () => Effect.die("unused"),
  getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
  getImportedAgentSessionSources: () => Effect.die("unused"),
  getThreadCheckpointContext: () => Effect.succeed(Option.none()),
  getFullThreadDiffContext: () => Effect.succeed(Option.none()),
  listActivitiesByKind: () => Effect.succeed([]),
  getThreadRuntimeContext: () => Effect.die("unused"),
  getTurnStartMessage: () => Effect.die("unused"),
  getThreadShellById: () => Effect.die("unused"),
  getThreadDetailById: () => Effect.die("unused"),
  getThreadDetailSnapshot: () => Effect.die("unused"),
  searchThreads: () => Effect.succeed({ matches: [] }),
  getAutomationById: () => Effect.die("unused"),
  listVisibleAutomations: () => Effect.die("unused"),
  listDueAutomations: () => Effect.die("unused"),
  listSettleCandidateAutomations: () => Effect.die("unused"),
};

const recordingEngine = (dispatchCalls: Ref.Ref<ReadonlyArray<Record<string, unknown>>>) =>
  ({
    readEvents: () => Stream.empty,
    readThreadEvents: () => Stream.empty,
    getThreadReplayStats: () => Effect.die("unused thread replay stats"),
    dispatch: (command: Record<string, unknown>) =>
      Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(Effect.as({ sequence: 1 })),
    streamDomainEvents: Stream.empty,
    subscribeDomainEvents: Effect.succeed(Stream.empty),
    latestSequence: Effect.succeed(0),
  }) satisfies OrchestrationEngine.OrchestrationEngineService["Service"];

it.effect("reuses the existing inbox project without dispatching", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = path.join("tmp", "fake-home");
    const inboxProjectId = ProjectId.make("project-inbox");
    const dispatchCalls = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
    const targets = yield* resolveInboxWelcomeTargets.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...unusedProjection,
        getActiveProjectByWorkspaceRoot: (workspaceRoot: string) =>
          Effect.succeed(
            Option.some({
              id: inboxProjectId,
              title: INBOX_PROJECT_TITLE,
              workspaceRoot,
              defaultModelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: DEFAULT_CODEX_MODEL,
              },
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
      }),
      Effect.provideService(
        OrchestrationEngine.OrchestrationEngineService,
        recordingEngine(dispatchCalls),
      ),
      Effect.provideService(HostProcessHomeDirectory, home),
    );

    assert.deepStrictEqual(targets, {
      inboxProjectId,
      inboxProjectCreated: false,
      inboxWorkspaceRoot: path.join(home, "Documents", "Doer"),
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("creates the inbox project including its directory", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const home = path.join("tmp", "fake-home");
    const dispatchCalls = yield* Ref.make<ReadonlyArray<Record<string, unknown>>>([]);
    const targets = yield* resolveInboxWelcomeTargets.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...unusedProjection,
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      }),
      Effect.provideService(
        OrchestrationEngine.OrchestrationEngineService,
        recordingEngine(dispatchCalls),
      ),
      Effect.provideService(HostProcessHomeDirectory, home),
    );

    if (!("inboxProjectId" in targets)) {
      assert.fail("expected inbox targets when creation succeeds");
    }
    assert.equal(targets.inboxProjectCreated, true);
    const calls = yield* Ref.get(dispatchCalls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.["type"], "project.create");
    assert.equal(calls[0]?.["title"], INBOX_PROJECT_TITLE);
    assert.equal(calls[0]?.["workspaceRoot"], path.join(home, "Documents", "Doer"));
    assert.equal(calls[0]?.["createWorkspaceRootIfMissing"], true);
    assert.equal(calls[0]?.["projectId"], targets.inboxProjectId);
    assert.equal(targets.inboxWorkspaceRoot, path.join(home, "Documents", "Doer"));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("degrades to no inbox when creation fails", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const targets = yield* resolveInboxWelcomeTargets.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...unusedProjection,
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: () => Effect.die(new Error("store unavailable")),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(HostProcessHomeDirectory, path.join("tmp", "fake-home")),
    );

    assert.deepStrictEqual(targets, {});
  }).pipe(Effect.provide(NodeServices.layer)),
);
