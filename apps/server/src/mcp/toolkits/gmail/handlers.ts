import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CommandId, EventId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  GmailConnection,
  type GmailConnectionError,
} from "../../../integrations/GmailConnection.ts";
import * as ExperimentalConnections from "../../../integrations/ExperimentalConnections.ts";
import { EXPERIMENTAL_CONNECTIONS_COPY } from "@t3tools/shared/experimentalConnections";
import { GmailSendApproval } from "../../../integrations/GmailSendApproval.ts";
import { encodeGmailMessage } from "../../../integrations/gmailClient.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GmailToolError, GmailToolkit } from "./tools.ts";
import { validateMailChange, type MailChange } from "../../../integrations/gmailMailbox.ts";

const make = Effect.gen(function* () {
  const gmail = yield* GmailConnection;
  const experimentalConnections = yield* ExperimentalConnections.ExperimentalConnections;
  const serverSettings = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const approvals = yield* GmailSendApproval;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  const access = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("gmail").pipe(
      Effect.mapError(
        () => new GmailToolError({ message: "Gmail is off. Enable it in Settings → Tools." }),
      ),
    );
    // Master switch is part of the live check below (not a one-time
    // pre-check): approval can pend while the user toggles, so the flag is
    // re-read both before review and after the user approves.
    const isAllowed = Effect.gen(function* () {
      if (!(yield* experimentalConnections.get)) return false;
      const settings = yield* serverSettings.getSettings;
      const thread = yield* snapshots.getThreadShellById(scope.threadId);
      if (
        Option.isNone(thread) ||
        thread.value.archivedAt !== null ||
        ["stopped", "interrupted", "error"].includes(thread.value.session?.status ?? "")
      )
        return false;
      return resolveProjectSettings(settings, thread.value.projectId).settings.enableGmailAccess;
    }).pipe(Effect.orElseSucceed(() => false));
    // Specific message for the master switch; isAllowed above stays the live
    // gate re-checked after approval resolves.
    if (!(yield* experimentalConnections.get))
      return yield* new GmailToolError({
        message: EXPERIMENTAL_CONNECTIONS_COPY.toolDenied,
      });
    if (!(yield* isAllowed))
      return yield* new GmailToolError({ message: "Gmail is off for this Space." });

    const account = yield* gmail.status;
    if (!account.connected || !account.email) {
      return yield* new GmailToolError({
        message: "Connect Gmail in Settings → Tools, then retry.",
      });
    }
    return { scope, isAllowed, sender: account.email };
  });

  const review = <A>(
    context: Effect.Success<typeof access>,
    operation: "send" | "change",
    detail: string,
    run: Effect.Effect<A, GmailConnectionError>,
  ) =>
    Effect.gen(function* () {
      const { scope, isAllowed } = context;
      const pending = yield* approvals.create(scope.threadId, operation);
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
                summary: resolved
                  ? "Gmail review closed"
                  : operation === "send"
                    ? "Review email before sending"
                    : "Review Gmail change",
                payload: {
                  requestId: pending.requestId,
                  requestKind: "mcp-elicitation",
                  requestType: "mcp_elicitation_approval",
                  appName: "Gmail",
                  ...(resolved
                    ? {}
                    : {
                        detail,
                        options: [
                          {
                            decision: "decline",
                            label: operation === "send" ? "Don't send" : "Don't change",
                          },
                          {
                            decision: "accept",
                            label: operation === "send" ? "Send this email" : "Apply this change",
                          },
                        ],
                      }),
                },
              },
            })
            .pipe(
              Effect.mapError(
                () =>
                  new GmailToolError({
                    message: "Could not record Gmail review. No action was performed.",
                  }),
              ),
            );
        });
      return yield* Effect.gen(function* () {
        yield* append(false);
        if (!(yield* pending.awaitDecision)) {
          return yield* new GmailToolError({
            message: "No Gmail action was performed because the user did not approve it.",
          });
        }
        if (!(yield* isAllowed))
          return yield* new GmailToolError({
            message:
              "Gmail access, experimental connections, or this task changed while awaiting approval. No action was performed.",
          });
        return yield* run.pipe(
          Effect.mapError((error) => new GmailToolError({ message: error.message })),
        );
      }).pipe(Effect.ensuring(pending.close), Effect.ensuring(append(true).pipe(Effect.ignore)));
    });

  const mailError = (error: GmailConnectionError) => new GmailToolError({ message: error.message });
  return GmailToolkit.of({
    gmail_send_email: (input) =>
      Effect.gen(function* () {
        const context = yield* access;
        const message = { to: [...input.to], subject: input.subject, body: input.body };
        yield* Effect.try({
          try: () => encodeGmailMessage(message),
          catch: () =>
            new GmailToolError({
              message: "Invalid email. Check recipients, subject and message size.",
            }),
        });
        return yield* review(
          context,
          "send",
          `From: ${context.sender}\nTo: ${message.to.join(", ")}\nSubject: ${message.subject}\n\n${message.body}`,
          gmail.send(message, context.sender),
        );
      }),
    gmail_search_messages: (input) =>
      Effect.gen(function* () {
        yield* access;
        return yield* gmail
          .search({
            query: input.query,
            ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
            ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
          })
          .pipe(Effect.mapError(mailError));
      }),
    gmail_read_message: (input) =>
      Effect.gen(function* () {
        const context = yield* access;
        return yield* gmail
          .readMessage(input.messageId, context.sender)
          .pipe(Effect.mapError(mailError));
      }),
    gmail_list_labels: (input) =>
      Effect.gen(function* () {
        yield* access;
        const result = yield* gmail.listLabels.pipe(Effect.mapError(mailError));
        return {
          ...result,
          labels: input.customOnly
            ? result.labels.filter((label) => label.id.startsWith("Label_"))
            : result.labels,
        };
      }),
    gmail_modify_message: (input) =>
      Effect.gen(function* () {
        const context = yield* access;
        const change: MailChange = {
          messageId: input.messageId,
          action: input.action,
          ...(input.labelId !== undefined ? { labelId: input.labelId } : {}),
        };
        yield* Effect.try({
          try: () => validateMailChange(change),
          catch: () =>
            new GmailToolError({
              message:
                "Invalid Gmail change. Use a message ID and, for labels, a custom label ID from gmail_list_labels.",
            }),
        });
        const message = yield* gmail
          .readMessage(change.messageId, context.sender)
          .pipe(Effect.mapError(mailError));
        let label = "";
        if (change.labelId) {
          const labels = yield* gmail.listLabels.pipe(Effect.mapError(mailError));
          const found = labels.labels.find((item) => item.id === change.labelId);
          if (!found)
            return yield* new GmailToolError({
              message: "Label not found in the available labels. No change was made.",
            });
          label = `\nLabel: ${found.name} (${found.id})`;
        }
        return yield* review(
          context,
          "change",
          `Account: ${context.sender}\nMessage ID: ${message.id}\nFrom: ${message.from}\nSubject: ${message.subject}\nAction: ${change.action}${label}\n\n${message.snippet}`,
          gmail.modify(change, context.sender),
        );
      }),
  });
});

export const GmailToolkitHandlersLive = GmailToolkit.toLayer(make);
