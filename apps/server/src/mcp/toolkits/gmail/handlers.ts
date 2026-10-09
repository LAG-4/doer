import { loadCaller, assertLiveCaller } from "../../threadAccess.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  GmailConnection,
  type GmailConnectionError,
} from "../../../integrations/GmailConnection.ts";
import * as ExperimentalConnections from "../../../integrations/ExperimentalConnections.ts";
import { EXPERIMENTAL_CONNECTIONS_COPY } from "@t3tools/shared/experimentalConnections";
// Elicitation only; registration stays in McpHttpServer behind McpToolAccess.
// oxlint-disable-next-line t3code/no-raw-mcp-registration
import { McpServer } from "effect/ai";
import * as Schema from "effect/Schema";
import { encodeGmailMessage } from "../../../integrations/gmailClient.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { DoerTaskContext as ProjectionSnapshotQuery } from "../../../memory/DoerTaskContext.ts";
import { GmailToolError, GmailToolkit } from "./tools.ts";
import { validateMailChange, type MailChange } from "../../../integrations/gmailMailbox.ts";

export const make = Effect.gen(function* () {
  const gmail = yield* GmailConnection;
  const experimentalConnections = yield* ExperimentalConnections.ExperimentalConnections;
  const serverSettings = yield* ServerSettingsService;
  const snapshots = yield* ProjectionSnapshotQuery;

  const access = Effect.gen(function* () {
    const scope = yield* McpInvocationContext.requireDoerCapability("gmail").pipe(
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
        thread.value.deletedAt !== null
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
      const confirmation = yield* McpServer.elicit({
        message: `${operation === "send" ? "Send this email?" : "Apply this Gmail change?"}\n\n${detail}`,
        schema: Schema.Struct({ approved: Schema.Boolean }),
      }).pipe(
        Effect.mapError(
          () =>
            new GmailToolError({
              message: "No Gmail action was performed because the user did not approve it.",
            }),
        ),
      );
      yield* loadCaller().pipe(
        Effect.flatMap(assertLiveCaller),
        Effect.mapError(
          () =>
            new GmailToolError({
              message: "This task stopped while awaiting approval. No Gmail action was performed.",
            }),
        ),
      );
      if (!confirmation.approved)
        return yield* new GmailToolError({
          message: "No Gmail action was performed because the user did not approve it.",
        });
      if (!(yield* isAllowed))
        return yield* new GmailToolError({
          message:
            "Gmail access, experimental connections, or this task changed while awaiting approval. No action was performed.",
        });
      return yield* run.pipe(
        Effect.mapError((error) => new GmailToolError({ message: error.message })),
      );
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

export const layer = McpToolAccess.toLayer(
  GmailToolkit,
  make.pipe(
    Effect.map((handlers) => ({
      gmail_send_email: McpToolAccess.actsAsCaller(handlers.gmail_send_email),
      gmail_search_messages: McpToolAccess.actsAsCaller(handlers.gmail_search_messages),
      gmail_read_message: McpToolAccess.actsAsCaller(handlers.gmail_read_message),
      gmail_list_labels: McpToolAccess.actsAsCaller(handlers.gmail_list_labels),
      gmail_modify_message: McpToolAccess.actsAsCaller(handlers.gmail_modify_message),
    })),
  ),
);
