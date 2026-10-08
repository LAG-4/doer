import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { MicrosoftConnection } from "../../../connectedApps/MicrosoftConnection.ts";
import * as ExperimentalConnections from "../../../integrations/ExperimentalConnections.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ConnectedAppsToolkitHandlersLive } from "./handlers.ts";
import { ConnectedAppsToolkit } from "./tools.ts";

const threadId = ThreadId.make("ms-task");

function scenario(experimental: boolean) {
  return Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      ExperimentalConnections.layerTest(experimental),
      // Layer.mock requires the class's plain-Promise methods in full
      // (only Effect members are optional); unused paths stay inert.
      Layer.mock(MicrosoftConnection)({
        status: () =>
          Promise.resolve({
            configured: true,
            connected: true,
            account: "test@example.com",
            sharePoint: false,
          }),
        start: () =>
          Promise.resolve({
            userCode: "code",
            verificationUrl: "https://microsoft.com",
            expiresAt: 1,
            intervalSeconds: 5,
          }),
        finish: () =>
          Promise.resolve({
            status: {
              configured: true,
              connected: true,
              account: "test@example.com",
              sharePoint: false,
            },
          }),
        disconnect: () =>
          Promise.resolve({
            configured: true,
            connected: false,
            account: null,
            sharePoint: false,
          }),
        downloadFile: () => Promise.resolve(new Uint8Array()),
        graph: () => Promise.resolve({ value: [] }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({}),
      Layer.mock(WorkspaceFileSystem)({}),
    );
    const toolkit = yield* ConnectedAppsToolkit.pipe(
      Effect.provide(ConnectedAppsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    return yield* toolkit
      .handle("read_connected_sources", { action: "find-sites", query: "team" })
      .pipe(
        Stream.unwrap,
        Stream.runDrain,
        Effect.result,
        Effect.provideService(McpInvocationContext.McpInvocationContext, {
          environmentId: EnvironmentId.make("host"),
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("opencode-custom"),
          capabilities: new Set<McpInvocationContext.McpCapability>([]),
          issuedAt: 1,
        }),
        Effect.provide(dependencies),
      );
  });
}

describe("connected apps experimental gate", () => {
  it.effect("denies Microsoft reads while the master switch is off", () =>
    Effect.gen(function* () {
      // A saved Microsoft token never bypasses the master switch.
      const denied = yield* scenario(false);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure")
        expect(String(denied.failure)).toContain("Experimental connections are off");
    }),
  );

  it.effect("allows Microsoft reads once the master switch is on", () =>
    Effect.gen(function* () {
      const allowed = yield* scenario(true);
      expect(allowed._tag).toBe("Success");
    }),
  );
});
