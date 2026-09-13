import {
  ComputerToolAllowInput,
  ComputerToolAllowResult,
  ComputerToolError,
  ComputerToolForgetInput,
  ComputerToolForgetResult,
  ComputerToolObserveInput,
  ComputerToolObserveResult,
  ComputerToolStartInput,
  ComputerToolStartResult,
  ComputerToolStatusInput,
  ComputerToolStatusResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/unstable/ai";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../../../config.ts";

import * as ComputerService from "../../../computer/ComputerService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, ComputerService.ComputerService];

/**
 * Deliberately a small surface: status, consent, and one image-returning
 * verb. Driving the desktop (click, type, keys, scroll) happens through the
 * preconfigured `computer-use` CLI, which speaks the upstream tool surface
 * directly and stays current with its own releases. Wrapping its commands
 * here would only lag behind it.
 */
const ComputerStatusTool = Tool.make("computer_status", {
  description:
    "Check computer use on this machine: platform support, helper install state, OS permission state, and which apps the user already approved. Call this before computer_start when you do not know the setup state.",
  parameters: ComputerToolStatusInput,
  success: ComputerToolStatusResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Computer use status")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ComputerStartTool = Tool.make("computer_start", {
  description:
    "Start computer use for this thread: ensures the helper, checks Accessibility and Screen Recording permissions, and shows how to drive the desktop with the computer-use CLI. Pass the app you want to operate; when it is not approved yet this fails and tells you to ask the user first.",
  parameters: ComputerToolStartInput,
  success: ComputerToolStartResult,
  failure: ComputerToolError,
  // The handler resolves the launcher shim, which needs the filesystem,
  // path, and server config services beyond the toolkit's base dependencies.
  dependencies: [...dependencies, FileSystem.FileSystem, Path.Path, ServerConfig],
})
  .annotate(Tool.Title, "Start computer use")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerAllowTool = Tool.make("computer_allow", {
  description:
    "Record the user's approval to see and operate an app with computer use. Call only after the user agreed in chat; the approval persists like an Always allow entry until computer_forget revokes it.",
  parameters: ComputerToolAllowInput,
  success: ComputerToolAllowResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Approve app for computer use")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ComputerForgetTool = Tool.make("computer_forget", {
  description: "Revoke computer use approval for an app, or for every app when omitted.",
  parameters: ComputerToolForgetInput,
  success: ComputerToolForgetResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Revoke computer use approval")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ComputerObserveTool = Tool.make("computer_observe", {
  description:
    "Capture an approved app's current screenshot plus accessibility tree. Call once per turn before interacting with the app; drive it with the computer-use CLI afterwards.",
  parameters: ComputerToolObserveInput,
  success: ComputerToolObserveResult,
  failure: ComputerToolError,
  dependencies,
})
  .annotate(Tool.Title, "Observe app")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerStandardToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerStartTool,
  ComputerAllowTool,
  ComputerForgetTool,
);

export const ComputerObserveToolkit = Toolkit.make(ComputerObserveTool);

export const ComputerToolkit = Toolkit.make(
  ComputerStatusTool,
  ComputerStartTool,
  ComputerAllowTool,
  ComputerForgetTool,
  ComputerObserveTool,
);
