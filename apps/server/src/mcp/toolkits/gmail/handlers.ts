import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpServerClient } from "effect/unstable/ai/McpSchema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GmailConnection } from "../../../integrations/GmailConnection.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GmailToolError, GmailToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const gmail = yield* GmailConnection;
  const serverSettings = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;

  return GmailToolkit.of({
    gmail_send_email: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("gmail").pipe(
          Effect.mapError(
            () => new GmailToolError({ message: "Gmail is off. Enable it in Settings → Tools." }),
          ),
        );
        // Re-read on every call so turning the switch off also stops an existing session.
        const allowed = yield* Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const thread = yield* snapshots.getThreadShellById(scope.threadId);
          if (Option.isNone(thread)) return false;
          return resolveProjectSettings(settings, thread.value.projectId).settings
            .enableGmailAccess;
        }).pipe(Effect.orElseSucceed(() => false));
        if (!allowed) return yield* new GmailToolError({ message: "Gmail is off for this Space." });

        const account = yield* gmail.status;
        if (!account.connected) {
          return yield* new GmailToolError({
            message: "Connect Gmail in Settings → Tools, then retry.",
          });
        }
        if (input.to.length === 0 || input.to.length > 20 || input.body.length > 50_000) {
          return yield* new GmailToolError({
            message: "Email must have 1–20 recipients and a body under 50,000 characters.",
          });
        }
        // OpenCode's native tool permission asks for this exact call. Other
        // providers use MCP elicitation; unsupported clients fail closed.
        if (scope.providerInstanceId !== "opencode") {
          const clientScope = yield* McpServerClient;
          const reviewed = yield* Effect.scoped(
            Effect.gen(function* () {
              const client = yield* clientScope.getClient;
              return yield* client.elicit({
                mode: "form",
                message: `Send this email from ${account.email ?? "Gmail"}?\n\nTo: ${input.to.join(", ")}\nSubject: ${input.subject}\n\n${input.body}`,
                requestedSchema: {
                  type: "object",
                  properties: {
                    approve: { type: "boolean", title: "Send this email", default: false },
                  },
                  required: ["approve"],
                },
              });
            }),
          ).pipe(Effect.orElseSucceed(() => ({ action: "decline" as const })));
          if (reviewed.action !== "accept" || reviewed.content?.approve !== true) {
            return yield* new GmailToolError({
              message: "The email was not sent because the user did not approve it.",
            });
          }
        }
        return yield* gmail
          .send(input)
          .pipe(Effect.mapError((error) => new GmailToolError({ message: error.message })));
      }),
  });
});

export const GmailToolkitHandlersLive = GmailToolkit.toLayer(make);
