import { ComputerToolUnavailableError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { ServerConfig } from "../../../config.ts";
import { ensureComputerShim } from "../../../computer/ComputerShim.ts";

import * as ComputerService from "../../../computer/ComputerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { pngDimensions } from "../device/handlers.ts";
import { ComputerObserveToolkit, ComputerStandardToolkit, ComputerToolkit } from "./tools.ts";

/**
 * Just-in-time guidance returned from `computer_start`. This is the one place
 * the agent learns how to drive the desktop, so it lives with the tool result
 * rather than in the always-on prompt block; threads that never start
 * computer use never pay for it.
 */
export function computerUseQuickStart(command: string, needsPermission: boolean): string {
  return [
    `Drive the desktop with ${command}. Use this exact executable path; login shells may reset PATH.`,
    "Typical loop (call get_app_state once per turn before acting):",
    `  ${command} call list_apps`,
    `  ${command} call get_app_state --args '{"app":"TextEdit"}'`,
    `  ${command} call click --args '{"app":"TextEdit","element_index":"0"}'`,
    `  ${command} call type_text --args '{"app":"TextEdit","text":"Hello"}'`,
    `  ${command} call press_key --args '{"app":"TextEdit","key":"Return"}'`,
    `  ${command} call set_value --args '{"app":"TextEdit","element_index":"1","value":"Draft"}'`,
    "For a short sequence that reuses element indexes in one process:",
    `  ${command} call --calls '[{"tool":"get_app_state","args":{"app":"TextEdit"}},{"tool":"press_key","args":{"app":"TextEdit","key":"Return"}}]'`,
    "Prefer element_index targets from the latest get_app_state over coordinates. Prefer set_value for editable controls.",
    "Never drive an app the user did not approve: computer_start refuses unapproved apps, and the CLI enforces the same list.",
    "Before driving an approved app for the first time in a task, tell the user what you are about to do so they can hand over the desktop.",
    "Treat the desktop as the user's real session. Ask before sending, deleting, purchasing, approving, uploading, or touching password managers or unrelated private content.",
    "Prefer a dedicated plugin or MCP integration when one can do the job; use computer use for the visual interaction it cannot.",
    needsPermission
      ? "OS permissions are still missing: ask the user to run `computer-use doctor` on this machine and grant Accessibility and Screen Recording to Open Computer Use, then call computer_start again."
      : "If an action reports missing permissions, ask the user to run `computer-use doctor` on this machine and grant what it asks for.",
  ].join("\n");
}

const requireComputerAccess = McpInvocationContext.requireMcpCapability("computer").pipe(
  Effect.mapError(
    () =>
      new ComputerToolUnavailableError({
        reason: "Agent computer access is turned off for this environment.",
      }),
  ),
);

/** Service and toolchain failures surface as tool errors carrying their message. */
const failAsUnavailable = <A, E>(
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, ComputerToolUnavailableError> =>
  effect.pipe(
    Effect.mapError((error) =>
      typeof error === "object" &&
      error !== null &&
      "_tag" in error &&
      error._tag === "ComputerToolUnavailableError"
        ? (error as unknown as ComputerToolUnavailableError)
        : new ComputerToolUnavailableError({ reason: errorMessage(error) }),
    ),
  );

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return typeof error.message === "string" ? error.message : String(error.message);
  }
  return String(error);
};

const handlers = {
  computer_status: (input) =>
    Effect.gen(function* () {
      yield* requireComputerAccess;
      const computers = yield* ComputerService.ComputerService;
      const state = yield* failAsUnavailable(computers.status);
      return {
        supported: state.supported,
        platform: state.platform,
        cliInstalled: state.cliInstalled,
        ...(state.cliVersion === undefined ? {} : { cliVersion: state.cliVersion }),
        ...(state.permissions === undefined ? {} : { permissions: state.permissions }),
        onboardingNeeded: state.onboardingNeeded,
        allowedApps: [...state.allowedApps],
        ...(input?.app === undefined
          ? {}
          : { appApproved: yield* failAsUnavailable(computers.isAllowed(input.app)) }),
      };
    }),
  computer_start: (input) =>
    Effect.gen(function* () {
      yield* requireComputerAccess;
      const computers = yield* ComputerService.ComputerService;
      // Resolve consent (per-app approval) before installing or launching anything.
      const started = yield* failAsUnavailable(
        computers.start(input?.app === undefined ? {} : { app: input.app }),
      );
      const config = yield* ServerConfig;
      const path = yield* Path.Path;
      const platform = yield* HostProcessPlatform;
      const shimDir = yield* ensureComputerShim({
        entryPath: started.entryPath,
        stateDir: config.stateDir,
        allowlistPath: path.join(config.stateDir, "computer", "allowed-apps.json"),
      }).pipe(
        Effect.mapError(
          () =>
            new ComputerToolUnavailableError({
              reason: "Could not prepare the computer-use launcher.",
            }),
        ),
      );
      const command = path.join(
        shimDir,
        platform === "win32" ? "computer-use.cmd" : "computer-use",
      );
      return {
        computerUse: { command, targetArgs: [] as ReadonlyArray<string> },
        needsPermission: started.needsPermission,
        appAllowed: started.appAllowed,
        platformNote: started.platformNote,
        quickStart: computerUseQuickStart(command, started.needsPermission),
      };
    }),
  computer_allow: (input) =>
    Effect.gen(function* () {
      yield* requireComputerAccess;
      const computers = yield* ComputerService.ComputerService;
      const allowedApps = yield* failAsUnavailable(computers.allow(input.app));
      return { app: input.app.trim(), allowedApps: [...allowedApps] };
    }),
  computer_forget: (input) =>
    Effect.gen(function* () {
      yield* requireComputerAccess;
      const computers = yield* ComputerService.ComputerService;
      const allowedApps = yield* failAsUnavailable(
        computers.forget(input?.app === undefined ? {} : { app: input.app }),
      );
      return { allowedApps: [...allowedApps] };
    }),
  computer_observe: (input) =>
    Effect.gen(function* () {
      yield* requireComputerAccess;
      const computers = yield* ComputerService.ComputerService;
      const seen = yield* failAsUnavailable(
        computers.observe({
          app: input.app,
          ...(input.textLimit === undefined ? {} : { textLimit: input.textLimit }),
          ...(input.maxTreeNodes === undefined ? {} : { maxTreeNodes: input.maxTreeNodes }),
          ...(input.maxTreeDepth === undefined ? {} : { maxTreeDepth: input.maxTreeDepth }),
        }),
      );
      return {
        app: seen.app,
        tree: seen.tree,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(seen.png).toString("base64"),
          ...pngDimensions(seen.png),
        },
      };
    }),
} satisfies Parameters<typeof ComputerToolkit.toLayer>[0];

const { computer_observe, ...standardHandlers } = handlers;

export const ComputerStandardToolkitHandlersLive =
  ComputerStandardToolkit.toLayer(standardHandlers);

export const ComputerObserveToolkitHandlersLive = ComputerObserveToolkit.toLayer({
  computer_observe,
});
