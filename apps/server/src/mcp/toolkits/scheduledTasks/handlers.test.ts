import {
  AutomationId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Automation,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { summarizeScheduledTask, ScheduledTasksToolkitHandlersLive } from "./handlers.ts";
import { ScheduledTasksToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const NOW = "2026-09-18T12:00:00.000Z";

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeThread(): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeAutomation(id: string, projectId: ProjectId = PROJECT_ID): Automation {
  return {
    id: AutomationId.make(id),
    projectId,
    threadId: ThreadId.make(`thread-for-${id}`),
    title: `Automation ${id}`,
    prompt: "Do the thing.",
    schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
    dedicatedThread: true,
    state: "active",
    nextFireAt: "2026-09-19T09:00:00.000Z",
    lastFiredAt: null,
    runs: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  };
}

interface HarnessOptions {
  readonly automations?: ReadonlyArray<Automation>;
  readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
}

const makeHarness = Effect.fn("makeScheduledTasksToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const automations = new Map((options.automations ?? []).map((row) => [row.id, row]));
  const thread = makeThread();
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) return yield* rejection;
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      if (command.type === "automation.create") {
        automations.set(command.automationId, {
          ...makeAutomation(command.automationId),
          projectId: command.projectId,
          threadId: command.threadId,
          title: command.title,
          prompt: command.prompt,
          schedule: command.schedule,
        });
      }
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.some(thread) : Option.none()),
      getAutomationById: (automationId) =>
        Effect.succeed(
          automations.get(automationId) === undefined
            ? Option.none()
            : Option.some(automations.get(automationId)!),
        ),
      listVisibleAutomations: () => Effect.succeed([...automations.values()]),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
  );
  const toolkit = yield* ScheduledTasksToolkit.pipe(
    Effect.provide(ScheduledTasksToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof ScheduledTasksToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["automations"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof ScheduledTasksToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { commands, call };
});

describe("scheduled tasks toolkit handlers", () => {
  it.effect("refuses a credential without the automations capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_scheduled_tasks", {}, ["pull-requests"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "automations",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("creates inside the calling thread by default, with no extra chat", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const summary = yield* harness.call("create_scheduled_task", {
        title: "Morning brief",
        prompt: "Summarize overnight activity.",
        schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
      });
      expect(summary.title).toBe("Morning brief");
      expect(summary.state).toBe("active");
      expect(summary.projectId).toBe(PROJECT_ID);
      // The run lives in the chat that asked: no thread.create dispatched.
      expect(summary.threadId).toBe(THREAD_ID);
      const dispatched = yield* Ref.get(harness.commands);
      expect(dispatched.map((command) => command.type)).toEqual(["automation.create"]);
      const create = dispatched[0];
      if (create?.type === "automation.create") {
        expect(create.dedicatedThread).toBe(false);
      } else {
        expect.unreachable("expected automation.create");
      }
    }),
  );

  it.effect("mints a full-access thread when asked for a new one", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const summary = yield* harness.call("create_scheduled_task", {
        title: "Morning brief",
        prompt: "Summarize overnight activity.",
        schedule: { kind: "daily", time: "09:00", timezone: "UTC" },
        thread: "new",
      });
      expect(summary.threadId).not.toBe(THREAD_ID);
      const dispatched = yield* Ref.get(harness.commands);
      expect(dispatched.map((command) => command.type)).toEqual([
        "thread.create",
        "automation.create",
      ]);
      const create = dispatched[0];
      if (create?.type === "thread.create") {
        expect(create.runtimeMode).toBe("full-access");
      } else {
        expect.unreachable("expected thread.create first");
      }
      const automationCreate = dispatched[1];
      if (automationCreate?.type === "automation.create") {
        expect(automationCreate.dedicatedThread).toBe(true);
      } else {
        expect.unreachable("expected automation.create second");
      }
    }),
  );

  it.effect("lists only this thread's project tasks", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        automations: [
          makeAutomation("automation-1"),
          makeAutomation("automation-foreign", ProjectId.make("project-other")),
        ],
      });
      const result = yield* harness.call("list_scheduled_tasks", {});
      expect(result.tasks.map((task) => task.automationId)).toEqual(["automation-1"]);
    }),
  );

  it.effect("rejects managing another project's task", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        automations: [makeAutomation("automation-foreign", ProjectId.make("project-other"))],
      });
      const error = yield* harness
        .call("pause_scheduled_task", { automationId: AutomationId.make("automation-foreign") })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ScheduledTaskNotFoundError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("pauses, resumes, runs now, and deletes through engine commands", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ automations: [makeAutomation("automation-1")] });
      yield* harness.call("pause_scheduled_task", {
        automationId: AutomationId.make("automation-1"),
      });
      yield* harness.call("resume_scheduled_task", {
        automationId: AutomationId.make("automation-1"),
      });
      yield* harness.call("run_scheduled_task_now", {
        automationId: AutomationId.make("automation-1"),
      });
      yield* harness.call("update_scheduled_task", {
        automationId: AutomationId.make("automation-1"),
        title: "Renamed",
      });
      yield* harness.call("delete_scheduled_task", {
        automationId: AutomationId.make("automation-1"),
      });
      expect((yield* Ref.get(harness.commands)).map((command) => command.type)).toEqual([
        "automation.pause",
        "automation.resume",
        "automation.run-now",
        "automation.update",
        "automation.delete",
      ]);
    }),
  );

  it.effect("surfaces engine rejections as tool failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        automations: [makeAutomation("automation-1")],
        reject: (command) =>
          command.type === "automation.pause"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "already paused",
              })
            : null,
      });
      const error = yield* harness
        .call("pause_scheduled_task", { automationId: AutomationId.make("automation-1") })
        .pipe(Effect.flip);
      expect(error._tag).toBe("ScheduledTaskPauseFailedError");
    }),
  );

  it.effect("summarizes run counts and the last outcome", () =>
    Effect.gen(function* () {
      const summary = summarizeScheduledTask(makeAutomation("automation-1"));
      expect(summary.runCount).toBe(0);
      expect(summary.lastOutcome).toBe(null);
      yield* Effect.void;
    }),
  );
});
