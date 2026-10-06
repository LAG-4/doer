import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";

export class LocalDocumentError extends Schema.TaggedError<LocalDocumentError>()(
  "LocalDocumentError",
  { message: Schema.String },
) {}

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ServerSettingsService,
  ProjectionSnapshotQuery,
  WorkspaceFileSystem,
];
const path = Schema.Struct({ path: Schema.String });

const inspectSpreadsheet = Tool.make("inspect_spreadsheet", {
  description:
    "Read the first sheet of a local .xlsx file in this Space. Returns its content and version hash for a later edit.",
  parameters: path,
  success: Schema.Struct({
    sha256: Schema.String,
    rows: Schema.Array(Schema.Array(Schema.String)),
    sheetNames: Schema.Array(Schema.String),
  }),
  failure: LocalDocumentError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect spreadsheet")
  .annotate(Tool.Readonly, true);

const replaceSpreadsheetCell = Tool.make("replace_spreadsheet_cell", {
  description:
    "Replace one existing non-formula cell on the first sheet of a local .xlsx file. Supply the SHA-256 from inspect_spreadsheet to avoid overwriting a changed file.",
  parameters: Schema.Struct({
    path: Schema.String,
    expectedSha256: Schema.String,
    cell: Schema.String,
    value: Schema.String,
  }),
  success: Schema.Struct({ sha256: Schema.String, backupPath: Schema.String }),
  failure: LocalDocumentError,
  dependencies,
})
  .annotate(Tool.Title, "Edit spreadsheet cell")
  .annotate(Tool.Readonly, false);

const inspectPresentation = Tool.make("inspect_presentation", {
  description:
    "Read text from the slides of a local .pptx file in this Space. Returns a version hash for a later edit. Each slide lists exact text runs; replace_presentation_text needs one exact run.",
  parameters: path,
  success: Schema.Struct({
    sha256: Schema.String,
    slides: Schema.Array(
      Schema.Struct({ slide: Schema.Number, text: Schema.String, runs: Schema.Array(Schema.String) }),
    ),
  }),
  failure: LocalDocumentError,
  dependencies,
})
  .annotate(Tool.Title, "Inspect presentation")
  .annotate(Tool.Readonly, true);

const replacePresentationText = Tool.make("replace_presentation_text", {
  description:
    "Replace an exact, unique text run on one slide of a local .pptx file. Supply the SHA-256 from inspect_presentation.",
  parameters: Schema.Struct({
    path: Schema.String,
    expectedSha256: Schema.String,
    slide: Schema.Number,
    oldText: Schema.String,
    newText: Schema.String,
  }),
  success: Schema.Struct({ sha256: Schema.String, backupPath: Schema.String }),
  failure: LocalDocumentError,
  dependencies,
})
  .annotate(Tool.Title, "Edit presentation text")
  .annotate(Tool.Readonly, false);

export const LocalDocumentsToolkit = Toolkit.make(
  inspectSpreadsheet,
  replaceSpreadsheetCell,
  inspectPresentation,
  replacePresentationText,
);
