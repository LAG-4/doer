import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { GmailConnection } from "../../../integrations/GmailConnection.ts";
import { McpSchema } from "effect/ai";
import * as DateTime from "effect/DateTime";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { DoerTaskContext as ProjectionSnapshotQuery } from "../../../memory/DoerTaskContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExperimentalConnections from "../../../integrations/ExperimentalConnections.ts";
import { GmailToolkitHandlersLive } from "./handlers.ts";
import { GmailToolkit } from "./tools.ts";

const threadId = ThreadId.make("mail-task");
const thread = {
  id: threadId,
  projectId: ProjectId.make("space"),
  title: "Email",
  modelSelection: { instanceId: ProviderInstanceId.make("opencode-custom"), model: "test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  archivedAt: null as DateTime.Utc | null,
  deletedAt: null as DateTime.Utc | null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

function scenario(
  decision: ProviderApprovalDecision,
  options: {
    disableAfterReview?: boolean;
    capability?: boolean;
    stopAfterReview?: boolean;
    archiveAfterReview?: boolean;
    startDisabled?: boolean;
    enableBeforeCall?: boolean;
    operation?: "send" | "change" | "read";
    experimental?: boolean;
    disableExperimentalAfterReview?: boolean;
  } = {},
) {
  return Effect.gen(function* () {
    const input = { to: ["recipient@example.com"], subject: "HI", body: "Exact message" };
    const commands: string[] = [];
    const sent: { message: typeof input; sender: string | undefined }[] = [];
    const change = { messageId: "abc123", action: "archive" as const };
    const changed: { messageId: string; sender: string }[] = [];
    let reads = 0;
    let enabled = !options.startDisabled;
    // Mutable master-switch backing: flipping it mid-review simulates the
    // user toggling experimental connections while approval pends.
    let experimental = options.experimental ?? true;
    let threadRow = thread;
    const dependencies = Layer.mergeAll(
      Layer.succeed(
        ExperimentalConnections.ExperimentalConnections,
        ExperimentalConnections.ExperimentalConnections.of({
          get: Effect.sync(() => experimental),
          setEnabled: (next) =>
            Effect.sync(() => {
              experimental = next;
            }),
        }),
      ),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.sync(() => ({
            ...liveThreadShell(id),
            providerInstanceId: ProviderInstanceId.make("opencode-custom"),
            activeRunId: threadRow.deletedAt === null ? liveThreadShell(id).activeRunId : null,
            archivedAt: threadRow.archivedAt,
          })),
      }),
      Layer.mock(GmailConnection)({
        status: Effect.succeed({ configured: true, connected: true, email: "sender@example.com" }),
        send: (message, sender) =>
          Effect.sync(() => {
            sent.push({ message: { ...message, to: [...message.to] }, sender });
            return { id: "sent-id" };
          }),
        readMessage: () =>
          Effect.sync(() => {
            reads++;
            return {
              id: "abc123",
              threadId: "mail-thread",
              from: "merchant@example.com",
              to: "sender@example.com",
              subject: "Invoice",
              date: "",
              snippet: "Your bill",
              labelIds: ["INBOX"],
              body: "Untrusted mail",
              bodyFormat: "text" as const,
              truncated: false,
              attachments: [],
            };
          }),
        modify: (message, sender) =>
          Effect.sync(() => {
            changed.push({ messageId: message.messageId, sender });
            return { id: message.messageId, labelIds: [] };
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.sync(() => Option.some(threadRow)),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.sync(() => ({
          ...DEFAULT_SERVER_SETTINGS,
          enableGmailAccess: enabled,
        })),
      }),
      Layer.succeed(
        McpSchema.McpServerClient,
        McpSchema.McpServerClient.of({
          clientId: 1,
          protocolVersion: "2025-06-18",
          clientCapabilities: { elicitation: {} },
          clientInfo: { name: "test", version: "1" },
          initializePayload: {
            protocolVersion: "2025-06-18",
            capabilities: { elicitation: {} },
            clientInfo: { name: "test", version: "1" },
          },
          getClient: Effect.succeed({
            listRoots: () => Effect.die("unused"),
            createMessage: () => Effect.die("unused"),
            elicit: (request) =>
              Effect.sync(() => {
                commands.push(request.message);
                if (options.operation === "change") {
                  expect(request.message).toContain("Message ID: abc123");
                  change.messageId = "hidden-message";
                } else {
                  expect(request.message).toContain(
                    "From: sender@example.com\nTo: recipient@example.com\nSubject: HI\n\nExact message",
                  );
                }
                input.to.push("hidden@example.com");
                input.body = "Changed after review";
                if (options.disableAfterReview) enabled = false;
                if (options.disableExperimentalAfterReview) experimental = false;
                if (options.stopAfterReview)
                  threadRow = {
                    ...thread,
                    deletedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
                  };
                if (options.archiveAfterReview)
                  threadRow = {
                    ...threadRow,
                    archivedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
                  };
                return { action: "accept" as const, content: { approved: decision === "accept" } };
              }),
          }),
        }),
      ),
      NodeServices.layer,
    );
    const toolkit = yield* GmailToolkit.pipe(
      Effect.provide(GmailToolkitHandlersLive.pipe(Layer.provide(dependencies))),
    );
    // Enabling mid-session with the existing credential must succeed: the
    // capability was issued independently of the toggle and the handler reads
    // the live switch on every call.
    if (options.enableBeforeCall) enabled = true;
    const invocation =
      options.operation === "change"
        ? toolkit.handle("gmail_modify_message", change).pipe(Stream.unwrap, Stream.runDrain)
        : options.operation === "read"
          ? toolkit
              .handle("gmail_read_message", { messageId: "abc123" })
              .pipe(Stream.unwrap, Stream.runDrain)
          : toolkit.handle("gmail_send_email", input).pipe(Stream.unwrap, Stream.runDrain);
    const result = yield* invocation.pipe(
      Effect.result,
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("host"),
        requestNamespace: "test",
        client: undefined,
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("opencode-custom"),
        },
        capabilities: new Set<McpInvocationContext.McpCapability>(
          options.capability === false ? [] : ["gmail"],
        ),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
    return { result, commands, sent, changed, reads };
  });
}

describe("Gmail tool email review", () => {
  it.effect("reads without a mailbox change and refuses reads when the capability is absent", () =>
    Effect.gen(function* () {
      const allowed = yield* scenario("accept", { operation: "read" });
      expect(allowed.result._tag).toBe("Success");
      expect(allowed.reads).toBe(1);
      expect(allowed.commands).toHaveLength(0);
      expect(allowed.sent).toHaveLength(0);
      expect(allowed.changed).toHaveLength(0);
      const denied = yield* scenario("accept", { operation: "read", capability: false });
      expect(denied.result._tag).toBe("Failure");
      expect(denied.reads).toBe(0);
    }),
  );
  it.effect("organizes only the exact reviewed message with one-use approval", () =>
    Effect.gen(function* () {
      const allowed = yield* scenario("accept", { operation: "change" });
      expect(allowed.result._tag).toBe("Success");
      expect(allowed.changed).toEqual([{ messageId: "abc123", sender: "sender@example.com" }]);
      for (const decision of ["decline", "acceptForSession"] as const) {
        const denied = yield* scenario(decision, { operation: "change" });
        expect(denied.result._tag).toBe("Failure");
        expect(denied.changed).toHaveLength(0);
      }
      for (const options of [
        { disableAfterReview: true },
        { stopAfterReview: true },
        { archiveAfterReview: true },
        { capability: false },
      ]) {
        const denied = yield* scenario("accept", { operation: "change", ...options });
        expect(denied.result._tag).toBe("Failure");
        expect(denied.changed).toHaveLength(0);
      }
    }),
  );
  it.effect(
    "sends only the reviewed content and sender in a full-access custom provider task",
    () =>
      Effect.gen(function* () {
        const test = yield* scenario("accept");
        expect(test.result._tag).toBe("Success");
        expect(test.sent).toEqual([
          {
            message: { to: ["recipient@example.com"], subject: "HI", body: "Exact message" },
            sender: "sender@example.com",
          },
        ]);
        expect(test.commands).toHaveLength(1);
      }),
  );
  it.effect("does not send when the user declines or grants session permission", () =>
    Effect.gen(function* () {
      for (const decision of ["decline", "acceptForSession"] as const) {
        const test = yield* scenario(decision);
        expect(test.result._tag).toBe("Failure");
        expect(test.sent).toHaveLength(0);
        expect(test.commands).toHaveLength(1);
      }
    }),
  );
  it.effect("rechecks the switch after approval and rejects missing tool access", () =>
    Effect.gen(function* () {
      const disabled = yield* scenario("accept", { disableAfterReview: true });
      expect(disabled.result._tag).toBe("Failure");
      expect(disabled.sent).toHaveLength(0);
      const denied = yield* scenario("accept", { capability: false });
      const stopped = yield* scenario("accept", { stopAfterReview: true });
      expect(stopped.result._tag).toBe("Failure");
      expect(stopped.sent).toHaveLength(0);
      const archived = yield* scenario("accept", { archiveAfterReview: true });
      expect(archived.result._tag).toBe("Failure");
      expect(archived.sent).toHaveLength(0);
      expect(denied.result._tag).toBe("Failure");
      expect(denied.sent).toHaveLength(0);
      expect(denied.commands).toHaveLength(0);
    }),
  );
  it.effect("allows a read when the switch starts off and is enabled mid-session", () =>
    Effect.gen(function* () {
      // The credential already carries the capability; only the live switch gates.
      const enabled = yield* scenario("accept", {
        operation: "read",
        startDisabled: true,
        enableBeforeCall: true,
      });
      expect(enabled.result._tag).toBe("Success");
      expect(enabled.reads).toBe(1);
      const stillOff = yield* scenario("accept", { operation: "read", startDisabled: true });
      expect(stillOff.result._tag).toBe("Failure");
      expect(stillOff.reads).toBe(0);
    }),
  );
  it.effect("denies reads and sends while the experimental master switch is off", () =>
    Effect.gen(function* () {
      // Stale per-tool opt-in, a connected account, and an issued capability
      // still cannot pass while the master switch is off.
      const read = yield* scenario("accept", { operation: "read", experimental: false });
      expect(read.result._tag).toBe("Failure");
      expect(read.reads).toBe(0);
      if (read.result._tag === "Failure")
        expect(String(read.result.failure)).toContain("Experimental connections are off");
      const send = yield* scenario("accept", { experimental: false });
      expect(send.result._tag).toBe("Failure");
      expect(send.sent).toHaveLength(0);
    }),
  );
  it.effect("does not send when the master switch turns off while approval pends", () =>
    Effect.gen(function* () {
      const test = yield* scenario("accept", { disableExperimentalAfterReview: true });
      expect(test.result._tag).toBe("Failure");
      expect(test.sent).toHaveLength(0);
    }),
  );
});
