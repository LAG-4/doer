import * as McpSchema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { McpServerClient } from "effect/unstable/ai/McpSchema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export class GmailToolError extends McpSchema.TaggedError<GmailToolError>()("GmailToolError", {
  message: McpSchema.String,
}) {}

const SendEmailInput = McpSchema.Struct({
  to: McpSchema.Array(McpSchema.String),
  subject: McpSchema.String,
  body: McpSchema.String,
});

const SendEmailTool = Tool.make("gmail_send_email", {
  description:
    "Send a plain-text email from the user's connected Gmail account. Only call this for an email the user explicitly requested with its exact recipients, subject, and body, or after they approved those exact details in the conversation. Ask for missing details before calling. If Gmail is disconnected, ask them to connect it in Settings → Tools.",
  parameters: SendEmailInput,
  success: McpSchema.Struct({
    id: McpSchema.String,
    threadId: McpSchema.optional(McpSchema.String),
  }),
  failure: GmailToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    McpServerClient,
    ServerSettingsService,
    ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "Send Gmail message")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const GmailToolkit = Toolkit.make(SendEmailTool);
