// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";
// @effect-diagnostics globalDateInEffect:off preferSchemaOverJson:off
import * as Effect from "effect/Effect";
import { MicrosoftConnection } from "../../../connectedApps/MicrosoftConnection.ts";
import { MicrosoftAccountError } from "../../../connectedApps/MicrosoftAccount.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ConnectedAppReadError, ConnectedAppsToolkit } from "./tools.ts";

export function connectedSourcePath(input: {
  action: string;
  query?: string | undefined;
  id?: string | undefined;
  siteId?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
}): string {
  const required = (value: string | undefined, name: string) => {
    if (!value?.trim())
      throw new MicrosoftAccountError(`Specify ${name} before reading this source.`);
    return value.trim();
  };
  const query = () => required(input.query, "what you want to find");
  switch (input.action) {
    case "search-email":
      return `/me/messages?${new URLSearchParams({ $search: `"${query().replaceAll('"', "").replaceAll("\\", "")}"`, $top: "10", $select: "id,subject,from,receivedDateTime,bodyPreview,webLink" })}`;
    case "read-email":
      return `/me/messages/${encodeURIComponent(required(input.id, "the email id from a search"))}?$select=id,subject,from,receivedDateTime,body,webLink`;
    case "calendar": {
      const start = required(input.start, "the calendar start date and timezone");
      const end = required(input.end, "the calendar end date and timezone");
      const begin = Date.parse(start),
        finish = Date.parse(end);
      if (
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(start) ||
        !/(?:Z|[+-]\d{2}:\d{2})$/.test(end) ||
        !Number.isFinite(begin) ||
        !Number.isFinite(finish) ||
        finish <= begin ||
        finish - begin > 31 * 86400000
      )
        throw new MicrosoftAccountError(
          "Choose a calendar range of up to 31 days with explicit timezone offsets.",
        );
      return `/me/calendarView?${new URLSearchParams({ startDateTime: start, endDateTime: end, $top: "50", $select: "id,subject,start,end,location,webLink" })}`;
    }
    case "search-files":
      return `/me/drive/root/search(q='${encodeURIComponent(query().replaceAll("'", "''"))}')?$top=10&$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference`;
    case "find-sites":
      return `/sites?${new URLSearchParams({ search: query(), $top: "10", $select: "id,displayName,webUrl,lastModifiedDateTime" })}`;
    case "search-site-files":
      return `/sites/${encodeURIComponent(required(input.siteId, "a SharePoint site id from a search"))}/drive/root/search(q='${encodeURIComponent(query().replaceAll("'", "''"))}')?$top=10&$select=id,name,webUrl,size,lastModifiedDateTime,file,folder,parentReference`;
    default:
      throw new MicrosoftAccountError("Choose a supported source to read.");
  }
}
const make = Effect.gen(function* () {
  const connection = yield* MicrosoftConnection;
  const snapshots = yield* ProjectionSnapshotQuery;
  const files = yield* WorkspaceFileSystem;
  return ConnectedAppsToolkit.of({
    read_connected_sources: (input) =>
      Effect.gen(function* () {
        yield* McpInvocationContext;
        return yield* Effect.tryPromise({
          try: async () => {
            const response = await connection.graph(connectedSourcePath(input));
            const contents = JSON.stringify(response);
            return {
              retrievedAt: new Date().toISOString(),
              sources: contents.slice(0, 60_000),
              truncated:
                contents.length > 60_000 ||
                (typeof response === "object" &&
                  response !== null &&
                  "@odata.nextLink" in response),
            };
          },
          catch: (error) =>
            new ConnectedAppReadError({
              detail:
                error instanceof MicrosoftAccountError
                  ? error.message
                  : "Could not read the Microsoft source. Your completed work is kept. Try again or attach an exported file.",
            }),
        });
      }),
    download_connected_file: (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext;
        const context = yield* snapshots.getThreadCheckpointContext(scope.threadId).pipe(
          Effect.mapError(
            () =>
              new ConnectedAppReadError({
                detail: "This Task's Space could not be loaded. Reconnect and retry.",
              }),
          ),
        );
        if (Option.isNone(context))
          return yield* new ConnectedAppReadError({ detail: "This Task is no longer available." });
        const bytes = yield* Effect.tryPromise({
          try: () => connection.downloadFile(input.id, input.driveId),
          catch: (cause) =>
            new ConnectedAppReadError({
              detail:
                cause instanceof MicrosoftAccountError
                  ? cause.message
                  : "The file download failed. Your completed work is kept; retry or attach an exported copy.",
            }),
        });
        const name =
          input.fileName
            .normalize("NFKC")
            .replace(/[^\p{L}\p{N} ._-]/gu, "")
            .replace(/^\.+/, "")
            .trim() || "Source";
        const relativePath = `Sources/${NodeCrypto.randomUUID().slice(0, 8)}-${name}`;
        yield* files
          .writeFile({
            cwd: context.value.worktreePath ?? context.value.workspaceRoot,
            relativePath,
            encoding: "base64",
            contents: Buffer.from(bytes).toString("base64"),
          })
          .pipe(
            Effect.mapError(
              () =>
                new ConnectedAppReadError({
                  detail:
                    "The downloaded file could not be saved in this Space. Check folder access and storage.",
                }),
            ),
          );
        return { relativePath, retrievedAt: new Date().toISOString() };
      }),
  });
});
export const ConnectedAppsToolkitHandlersLive = ConnectedAppsToolkit.toLayer(make);
