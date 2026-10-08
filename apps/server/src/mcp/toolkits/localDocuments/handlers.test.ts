import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { bytesToBase64, createSpreadsheet } from "@t3tools/shared/spreadsheetWorkbook";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExperimentalConnections from "../../../integrations/ExperimentalConnections.ts";
import { LocalDocumentsToolkitHandlersLive } from "./handlers.ts";
import { LocalDocumentsToolkit } from "./tools.ts";

const threadId = ThreadId.make("sheet-task");
const projectId = ProjectId.make("space");
const thread: OrchestrationThreadShell = {
  id: threadId,
  projectId,
  title: "Sheet",
  modelSelection: { instanceId: ProviderInstanceId.make("opencode-custom"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const project = {
  id: projectId,
  title: "Space",
  workspaceRoot: "/tmp/space",
} as unknown as OrchestrationProjectShell;

function scenario(
  options: {
    capability?: boolean;
    startDisabled?: boolean;
    enableBeforeCall?: boolean;
    disableBeforeCall?: boolean;
    stopBeforeCall?: boolean;
    archiveBeforeCall?: boolean;
    experimental?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    let enabled = !options.startDisabled;
    let threadRow = thread;
    if (options.stopBeforeCall) {
      threadRow = {
        ...thread,
        session: {
          threadId,
          status: "stopped",
          providerName: "opencode",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-10-04T00:00:00.000Z",
        },
      };
    }
    if (options.archiveBeforeCall) {
      threadRow = { ...threadRow, archivedAt: "2026-10-05T00:00:00.000Z" };
    }
    const workbook = bytesToBase64(yield* Effect.promise(() => createSpreadsheet([["Hello"]])));
    const dependencies = Layer.mergeAll(
      ExperimentalConnections.layerTest(options.experimental ?? true),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.sync(() => Option.some(threadRow)),
        getProjectShellById: () => Effect.sync(() => Option.some(project)),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          enableLocalSpreadsheetAccess: enabled,
        })),
      }),
      Layer.mock(WorkspaceFileSystem)({
        readFile: () =>
          Effect.succeed({
            relativePath: "sheet.xlsx",
            contents: workbook,
            byteLength: workbook.length,
            truncated: false,
          }),
      }),
    );
    const toolkit = yield* LocalDocumentsToolkit.pipe(
      Effect.provide(LocalDocumentsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    // Flip the live switch with the same issued credential in place.
    if (options.enableBeforeCall) enabled = true;
    if (options.disableBeforeCall) enabled = false;
    const result = yield* toolkit.handle("inspect_spreadsheet", { path: "sheet.xlsx" }).pipe(
      Stream.unwrap,
      Stream.runDrain,
      Effect.result,
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("host"),
        threadId,
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("opencode-custom"),
        capabilities: new Set<McpInvocationContext.McpCapability>(
          options.capability === false ? [] : ["local-spreadsheets"],
        ),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
    return result;
  });
}

describe("local spreadsheet live switch", () => {
  it.effect("allows inspect when the switch starts off and is enabled mid-task", () =>
    Effect.gen(function* () {
      const enabled = yield* scenario({ startDisabled: true, enableBeforeCall: true });
      expect(enabled._tag).toBe("Success");
      const stillOff = yield* scenario({ startDisabled: true });
      expect(stillOff._tag).toBe("Failure");
    }),
  );

  it.effect("denies an enabled credential once the switch turns off", () =>
    Effect.gen(function* () {
      const denied = yield* scenario({ disableBeforeCall: true });
      expect(denied._tag).toBe("Failure");
    }),
  );

  it.effect("denies stopped and archived tasks", () =>
    Effect.gen(function* () {
      expect((yield* scenario({ stopBeforeCall: true }))._tag).toBe("Failure");
      expect((yield* scenario({ archiveBeforeCall: true }))._tag).toBe("Failure");
    }),
  );

  it.effect("denies a credential without the capability", () =>
    Effect.gen(function* () {
      expect((yield* scenario({ capability: false }))._tag).toBe("Failure");
    }),
  );

  it.effect("denies calls while the experimental master switch is off", () =>
    Effect.gen(function* () {
      // Stale per-tool opt-in plus an issued capability still cannot pass.
      const denied = yield* scenario({ experimental: false });
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure")
        expect(String(denied.failure)).toContain("Experimental connections are off");
    }),
  );
});
