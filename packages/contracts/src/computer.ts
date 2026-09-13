import * as Schema from "effect/Schema";

/**
 * Computer use: the agent sees the user's desktop and operates real GUI apps
 * (Codex-app parity), driven by the pinned `open-computer-use` CLI. The tool
 * surface deliberately mirrors `device_*`: lifecycle verbs here, driving via
 * the CLI on PATH, one image-returning verb for providers that need
 * tool-result images. Wrapping every upstream tool would only lag behind its
 * releases.
 */

// MCP tool shapes. Kept next to the service shapes so the tool surface and
// any future panel describe computer use the same way.

/** App name or bundle identifier as returned by `computer_status` / `list_apps`. */
export const ComputerAppRef = Schema.String.annotate({
  description: 'App name or bundle identifier, e.g. "TextEdit" or "com.apple.TextEdit".',
});
export type ComputerAppRef = typeof ComputerAppRef.Type;

export const ComputerToolStatusInput = Schema.Struct({
  app: Schema.optional(
    ComputerAppRef.annotate({
      description: "When given, the result also reports whether this app is already approved.",
    }),
  ),
});
export type ComputerToolStatusInput = typeof ComputerToolStatusInput.Type;

export const ComputerToolStatusResult = Schema.Struct({
  /** False on platforms the runtime does not support (e.g. headless Linux without a desktop session). */
  supported: Schema.Boolean,
  platform: Schema.String,
  cliInstalled: Schema.Boolean,
  cliVersion: Schema.optional(Schema.String),
  /** macOS Accessibility + Screen Recording state; null when unknown (run `computer_start` to check). */
  permissions: Schema.optional(
    Schema.Struct({
      accessibility: Schema.Boolean,
      screenRecording: Schema.Boolean,
    }),
  ),
  /** True when the user still has to grant OS permissions / pick the target app. */
  onboardingNeeded: Schema.Boolean,
  /** Apps the user already approved, mirroring Codex's "Always allow" list. */
  allowedApps: Schema.Array(Schema.String),
  /** Whether `app` from the input is approved. Absent when no app was given. */
  appApproved: Schema.optional(Schema.Boolean),
});
export type ComputerToolStatusResult = typeof ComputerToolStatusResult.Type;

export const ComputerToolStartInput = Schema.Struct({
  app: Schema.optional(
    ComputerAppRef.annotate({
      description:
        "App the agent wants to operate. Omit to start computer use without targeting an app yet.",
    }),
  ),
}).annotate({
  description:
    "Start computer use for this thread. Ensures the helper CLI, checks OS permissions, and returns how to drive the desktop with the computer-use CLI.",
});
export type ComputerToolStartInput = typeof ComputerToolStartInput.Type;

export const ComputerToolStartResult = Schema.Struct({
  /** Ready-to-run launcher invocation pinned to the verified CLI install. */
  computerUse: Schema.Struct({
    command: Schema.String,
    /** Extra flags, currently empty; kept so scripts can splice blindly. */
    targetArgs: Schema.Array(Schema.String),
  }),
  /** True when the user must still grant Accessibility / Screen Recording. */
  needsPermission: Schema.Boolean,
  /** Whether `app` (when given) is already approved. */
  appAllowed: Schema.Boolean,
  /** Windows takes over the foreground while computer use runs; macOS usually does not. */
  platformNote: Schema.String,
  quickStart: Schema.String,
});
export type ComputerToolStartResult = typeof ComputerToolStartResult.Type;

export const ComputerToolAllowInput = Schema.Struct({
  app: ComputerAppRef,
}).annotate({
  description:
    "Record the user's approval to operate an app (Codex's per-app prompt / Always allow). Call only after the user agreed in chat.",
});
export type ComputerToolAllowInput = typeof ComputerToolAllowInput.Type;

export const ComputerToolAllowResult = Schema.Struct({
  app: Schema.String,
  allowedApps: Schema.Array(Schema.String),
});
export type ComputerToolAllowResult = typeof ComputerToolAllowResult.Type;

export const ComputerToolForgetInput = Schema.Struct({
  app: Schema.optional(
    ComputerAppRef.annotate({
      description: "App to remove from the allow list. Omit to revoke all apps.",
    }),
  ),
});
export type ComputerToolForgetInput = typeof ComputerToolForgetInput.Type;

export const ComputerToolForgetResult = Schema.Struct({
  allowedApps: Schema.Array(Schema.String),
});
export type ComputerToolForgetResult = typeof ComputerToolForgetResult.Type;

export const ComputerToolObserveInput = Schema.Struct({
  app: ComputerAppRef,
  textLimit: Schema.optional(
    Schema.Union([Schema.Int, Schema.Literal("max")]).annotate({
      description:
        "Maximum accessibility-tree text characters. Use a larger value for chat history, email bodies, or documents. Defaults to 500.",
    }),
  ),
  maxTreeNodes: Schema.optional(
    Schema.Int.annotate({
      description:
        "Maximum accessibility tree nodes. Defaults to 1200; raise for long pages or lists.",
    }),
  ),
  maxTreeDepth: Schema.optional(
    Schema.Int.annotate({
      description: "Maximum accessibility tree depth. Defaults to 64.",
    }),
  ),
}).annotate({
  description:
    "Capture an app's current screenshot plus accessibility tree. Call once per turn before interacting with the app.",
});
export type ComputerToolObserveInput = typeof ComputerToolObserveInput.Type;

export const ComputerToolObserveResult = Schema.Struct({
  app: Schema.String,
  /** Accessibility tree text; the screenshot bytes travel as image content. */
  tree: Schema.String,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type ComputerToolObserveResult = typeof ComputerToolObserveResult.Type;

export class ComputerToolUnavailableError extends Schema.TaggedError<ComputerToolUnavailableError>()(
  "ComputerToolUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const ComputerToolError = Schema.Union([ComputerToolUnavailableError]);
export type ComputerToolError = typeof ComputerToolError.Type;
