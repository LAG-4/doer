import * as McpSchema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";
import { GmailSendApproval } from "../../../integrations/GmailSendApproval.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";

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
    "Request sending a plain-text email from the user's connected Gmail account. Doer displays the exact email for a one-time user approval before sending. Ask for missing details before calling. Do not retry after uncertain delivery: ask the user to check Gmail's Sent folder first. If disconnected, ask them to connect Gmail in Settings → Tools.",
  parameters: SendEmailInput,
  success: McpSchema.Struct({
    id: McpSchema.String,
    threadId: McpSchema.optional(McpSchema.String),
  }),
  failure: GmailToolError,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    GmailSendApproval,
    OrchestrationEngineService,
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
