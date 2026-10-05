import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CommandId, EventId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { GmailConnection } from "../../../integrations/GmailConnection.ts";
import { GmailSendApproval } from "../../../integrations/GmailSendApproval.ts";
import { encodeGmailMessage } from "../../../integrations/gmailClient.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GmailToolError, GmailToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const gmail = yield* GmailConnection;
  const serverSettings = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const approvals = yield* GmailSendApproval;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  return GmailToolkit.of({
    gmail_send_email: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.requireMcpCapability("gmail").pipe(
          Effect.mapError(
            () => new GmailToolError({ message: "Gmail is off. Enable it in Settings → Tools." }),
          ),
        );
        // Re-read on every call so turning the switch off also stops an existing session.
        const isAllowed = Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const thread = yield* snapshots.getThreadShellById(scope.threadId);
          if (
            Option.isNone(thread) ||
            thread.value.archivedAt !== null ||
            ["stopped", "interrupted", "error"].includes(thread.value.session?.status ?? "")
          )
            return false;
          return resolveProjectSettings(settings, thread.value.projectId).settings
            .enableGmailAccess;
        }).pipe(Effect.orElseSucceed(() => false));
        if (!(yield* isAllowed))
          return yield* new GmailToolError({ message: "Gmail is off for this Space." });

        const account = yield* gmail.status;
        if (!account.connected || !account.email) {
          return yield* new GmailToolError({
            message: "Connect Gmail in Settings → Tools, then retry.",
          });
        }
        // Capture and validate the exact content that will be sent before publishing it.
        const sender = account.email;
        const message = { to: [...input.to], subject: input.subject, body: input.body };
        yield* Effect.try({
          try: () => encodeGmailMessage(message),
          catch: () =>
            new GmailToolError({
              message: "Invalid email. Check recipients, subject and message size.",
            }),
        });
        const pending = yield* approvals.create(scope.threadId);
        const append = (resolved: boolean) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
            const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
            yield* engine
              .dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`gmail:${uuid}`),
                threadId: scope.threadId,
                createdAt,
                activity: {
                  id: EventId.make(uuid),
                  createdAt,
                  turnId: null,
                  tone: "approval",
                  kind: resolved ? "approval.resolved" : "approval.requested",
                  summary: resolved ? "Email review closed" : "Review email before sending",
                  payload: {
                    requestId: pending.requestId,
                    requestKind: "mcp-elicitation",
                    requestType: "mcp_elicitation_approval",
                    appName: "Gmail",
                    ...(resolved
                      ? {}
                      : {
                          detail: `From: ${sender}\nTo: ${message.to.join(", ")}\nSubject: ${message.subject}\n\n${message.body}`,
                          options: [
                            { decision: "decline", label: "Don't send" },
                            { decision: "accept", label: "Send this email" },
                          ],
                        }),
                  },
                },
              })
              .pipe(
                Effect.mapError(
                  () =>
                    new GmailToolError({
                      message: "Could not record email review. The email was not sent.",
                    }),
                ),
              );
          });
        return yield* Effect.gen(function* () {
          yield* append(false);
          if (!(yield* pending.awaitDecision)) {
            return yield* new GmailToolError({
              message: "The email was not sent because the user did not approve it.",
            });
          }
          if (!(yield* isAllowed))
            return yield* new GmailToolError({
              message:
                "Gmail access or this task changed while awaiting approval. The email was not sent.",
            });
          return yield* gmail
            .send(message, sender)
            .pipe(Effect.mapError((error) => new GmailToolError({ message: error.message })));
        }).pipe(Effect.ensuring(pending.close), Effect.ensuring(append(true).pipe(Effect.ignore)));
      }),
  });
});

export const GmailToolkitHandlersLive = GmailToolkit.toLayer(make);
