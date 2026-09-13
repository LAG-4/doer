import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as ServerConfig from "../config.ts";
import * as ComputerService from "../computer/ComputerService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

const environmentId = EnvironmentId.make("environment-computer-test");
const threadId = ThreadId.make("thread-computer-test");
const invocation = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) => ({
  environmentId,
  threadId,
  providerSessionId: "provider-session-computer-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const png = new Uint8Array(24);
new DataView(png.buffer).setUint32(0, 0x89504e47);
new DataView(png.buffer).setUint32(4, 0x0d0a1a0a);
new DataView(png.buffer).setUint32(12, 0x49484452);
new DataView(png.buffer).setUint32(16, 1206);
new DataView(png.buffer).setUint32(20, 2622);

const ComputerServiceMock = Layer.mock(ComputerService.ComputerService)({
  status: Effect.succeed({
    supported: true,
    platform: "darwin",
    cliInstalled: true,
    cliVersion: "0.3.5",
    permissions: { accessibility: true, screenRecording: true },
    onboardingNeeded: false,
    allowedApps: ["TextEdit"],
  }),
  isAllowed: (app: string) => Effect.succeed(app === "TextEdit"),
  start: (input) =>
    Effect.succeed({
      entryPath: "/cli/ocu",
      needsPermission: false,
      permissions: { accessibility: true, screenRecording: true },
      appAllowed: input.app === undefined || input.app === "TextEdit",
      platformNote: "macOS note",
    }),
  allow: (app: string) => Effect.succeed(["TextEdit", app.trim()]),
  forget: () => Effect.succeed([]),
  observe: () => Effect.succeed({ app: "TextEdit", tree: "[0] button", png }),
});

const TestLayer = McpHttpServer.ComputerToolkitRegistrationLive.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(ComputerServiceMock),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-computer-toolkit-test-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("registers the computer tools and returns observe as image content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const names = server.tools.map(({ tool }) => tool.name).toSorted();
      expect(names).toEqual([
        "computer_allow",
        "computer_forget",
        "computer_observe",
        "computer_start",
        "computer_status",
      ]);

      const callWith = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities));

      const status = yield* server
        .callTool({ name: "computer_status", arguments: {} })
        .pipe(callWith(["computer"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(status.isError).toBe(false);
      expect(status.structuredContent).toMatchObject({ cliInstalled: true });

      const started = yield* server
        .callTool({ name: "computer_start", arguments: { app: "TextEdit" } })
        .pipe(callWith(["computer"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(started.isError).toBe(false);
      const startedContent = started.structuredContent as { quickStart: string };
      expect(startedContent.quickStart).toContain("computer-use call list_apps");

      const seen = yield* server
        .callTool({ name: "computer_observe", arguments: { app: "TextEdit" } })
        .pipe(callWith(["computer"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(seen.isError).toBe(false);
      expect(seen.content.map((entry) => entry.type)).toEqual(["text", "image"]);
      expect(seen.structuredContent).toMatchObject({
        app: "TextEdit",
        screenshot: { mimeType: "image/png", width: 1206, height: 2622 },
      });

      const denied = yield* server
        .callTool({ name: "computer_status", arguments: {} })
        .pipe(callWith(["preview"]), Effect.provideService(McpSchema.McpServerClient, client));
      expect(denied.isError).toBe(true);
    }),
  ).pipe(Effect.provide(TestLayer)),
);

it.effect("surfaces the approval failure when the app is not approved", () => {
  const unapproved = Layer.mock(ComputerService.ComputerService)({
    start: () =>
      Effect.fail(
        new ComputerService.ComputerUseError({
          operation: "starting computer use",
          reason: 'The user has not approved "Chess" yet.',
        }),
      ),
  });
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name: "computer_start", arguments: { app: "Chess" } })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(["computer"])),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError).toBe(true);
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("has not approved"),
        }),
      ]),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      McpHttpServer.ComputerToolkitRegistrationLive.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(unapproved),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});
