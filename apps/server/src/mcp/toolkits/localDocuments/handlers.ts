// @effect-diagnostics nodeBuiltinImport:off
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as NodeCrypto from "node:crypto";
import {
  base64ToBytes,
  parseSpreadsheet,
  replaceSpreadsheetCell,
} from "@t3tools/shared/spreadsheetWorkbook";
import { inspectPresentation, replacePresentationText } from "@t3tools/shared/presentationDocument";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExperimentalConnections from "../../../integrations/ExperimentalConnections.ts";
import { EXPERIMENTAL_CONNECTIONS_COPY } from "@t3tools/shared/experimentalConnections";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { DoerTaskContext as ProjectionSnapshotQuery } from "../../../memory/DoerTaskContext.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";
import { replaceLocalDocument } from "../../../integrations/localDocumentWrite.ts";
import { withWorkspaceLease } from "../../../workspace/workspaceLease.ts";
import { LocalDocumentError, LocalDocumentsToolkit } from "./tools.ts";

type Kind = "local-spreadsheets" | "local-presentations";
const failure = (message: string) => new LocalDocumentError({ message });
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const experimentalConnections = yield* ExperimentalConnections.ExperimentalConnections;
  const snapshots = yield* ProjectionSnapshotQuery;
  const files = yield* WorkspaceFileSystem;

  const workspace = (kind: Kind) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.requireDoerCapability(kind).pipe(
        Effect.mapError(() =>
          failure("This local file tool is off. Enable it in Settings → Tools."),
        ),
      );
      // Master switch first: stale per-tool toggles never bypass it.
      if (!(yield* experimentalConnections.get))
        return yield* failure(EXPERIMENTAL_CONNECTIONS_COPY.toolDenied);
      const thread = yield* snapshots
        .getThreadShellById(scope.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(thread)) return yield* failure("Task was not found.");
      if (thread.value.archivedAt !== null || thread.value.deletedAt !== null) {
        return yield* failure("Task is no longer active. Inspect it again from the current task.");
      }
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(() => failure("Could not read tool settings.")),
      );
      const enabled = resolveProjectSettings(settings, thread.value.projectId).settings;
      if (
        !(kind === "local-spreadsheets"
          ? enabled.enableLocalSpreadsheetAccess
          : enabled.enableLocalPresentationAccess)
      ) {
        return yield* failure("This local file tool is off for this Space.");
      }
      const project = yield* snapshots
        .getProjectShellById(thread.value.projectId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(project)) return yield* failure("Space was not found.");
      return project.value.workspaceRoot;
    });

  const read = (kind: Kind, path: string) =>
    Effect.gen(function* () {
      const extension = kind === "local-spreadsheets" ? ".xlsx" : ".pptx";
      if (
        !path.toLowerCase().endsWith(extension) ||
        path.length > 1024 ||
        /^[\\/]/.test(path) ||
        /^[a-z]:/i.test(path)
      ) {
        return yield* failure(`Choose a ${extension} file inside this Space.`);
      }
      const cwd = yield* workspace(kind);
      const result = yield* files
        .readFile({ cwd, relativePath: path, encoding: "base64" })
        .pipe(Effect.mapError(() => failure("Could not read this file inside the Space.")));
      if (result.truncated) return yield* failure("File is larger than the 1 MB local tool limit.");
      const bytes = base64ToBytes(result.contents);
      return { cwd, bytes, sha256: sha256(bytes) };
    });

  const update = (
    kind: Kind,
    path: string,
    expectedSha256: string,
    edit: (bytes: Uint8Array) => Promise<Uint8Array>,
  ) =>
    Effect.gen(function* () {
      const cwd = yield* workspace(kind);
      return yield* withWorkspaceLease(
        cwd,
        Effect.gen(function* () {
          const current = yield* read(kind, path);
          if (current.sha256 !== expectedSha256)
            return yield* failure("File changed since inspection. Inspect it again.");
          const updated = yield* Effect.tryPromise({
            try: () => edit(current.bytes),
            catch: (cause) =>
              failure(cause instanceof Error ? cause.message : "Could not edit this file."),
          });
          const saved = yield* Effect.tryPromise({
            try: () =>
              replaceLocalDocument({
                cwd: current.cwd,
                relativePath: path,
                expectedSha256,
                contents: updated,
              }),
            catch: () =>
              failure(
                "Could not save the document. It may have changed or be open in another app. Inspect it again; the original was preserved.",
              ),
          });
          return { sha256: sha256(updated), backupPath: saved.backupPath };
        }),
      );
    });

  return LocalDocumentsToolkit.of({
    inspect_spreadsheet: ({ path }) =>
      Effect.gen(function* () {
        const file = yield* read("local-spreadsheets", path);
        const sheet = yield* Effect.tryPromise({
          try: () => parseSpreadsheet(file.bytes),
          catch: () => failure("Could not read this spreadsheet."),
        });
        return { sha256: file.sha256, rows: sheet.rows, sheetNames: sheet.sheetNames };
      }),
    replace_spreadsheet_cell: ({ path, expectedSha256, cell, value }) =>
      update("local-spreadsheets", path, expectedSha256, (bytes) =>
        replaceSpreadsheetCell(bytes, cell, value),
      ),
    inspect_presentation: ({ path }) =>
      Effect.gen(function* () {
        const file = yield* read("local-presentations", path);
        const slides = yield* Effect.tryPromise({
          try: () => inspectPresentation(file.bytes),
          catch: () => failure("Could not read this presentation."),
        });
        return { sha256: file.sha256, slides };
      }),
    replace_presentation_text: ({ path, expectedSha256, slide, oldText, newText }) =>
      update("local-presentations", path, expectedSha256, (bytes) =>
        replacePresentationText(bytes, slide, oldText, newText),
      ),
  });
});

export const LocalDocumentsToolkitHandlersLive = LocalDocumentsToolkit.toLayer(make);

export const layer = McpToolAccess.toLayer(
  LocalDocumentsToolkit,
  make.pipe(
    Effect.map((handlers) => ({
      inspect_spreadsheet: McpToolAccess.actsAsCaller(handlers.inspect_spreadsheet),
      replace_spreadsheet_cell: McpToolAccess.actsAsCaller(handlers.replace_spreadsheet_cell),
      inspect_presentation: McpToolAccess.actsAsCaller(handlers.inspect_presentation),
      replace_presentation_text: McpToolAccess.actsAsCaller(handlers.replace_presentation_text),
    })),
  ),
);
