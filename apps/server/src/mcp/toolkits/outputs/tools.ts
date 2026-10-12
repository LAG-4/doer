import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { DoerTaskContext as ProjectionSnapshotQuery } from "../../../memory/DoerTaskContext.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";

const Text = Schema.String.check(Schema.isMaxLength(8_000));
const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));
const Result = Schema.Struct({
  relativePath: Schema.String,
  format: Schema.Literals(["docx", "xlsx", "pptx"]),
});
export class OutputFailedError extends Schema.TaggedError<OutputFailedError>()(
  "OutputFailedError",
  { detail: Schema.String },
) {
  override get message() {
    return `Could not create the file. ${this.detail} Keep the draft and try again.`;
  }
}
const dependencies = [
  ThreadManagementService.ThreadManagementService,
  McpInvocationContext,
  ProjectionSnapshotQuery,
  WorkspaceFileSystem,
];
const document = Tool.make("create_document", {
  description:
    "Create a formatted Word document in this Task's Space, using Doer's bundled tools. Supply a short title and sections of plain text. Write complete reviewed content; never invent personal facts. Returns a relative file path: link it in your response. Each call saves a new copy and keeps previous files.",
  parameters: Schema.Struct({
    title: Title,
    sections: Schema.Array(
      Schema.Struct({
        heading: Schema.String.check(Schema.isMaxLength(200)),
        paragraphs: Schema.Array(Text).check(Schema.isMaxLength(100)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  }),
  success: Result,
  failure: Schema.Union([OutputFailedError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Create document")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const spreadsheet = Tool.make("create_spreadsheet", {
  description:
    "Create an Excel workbook in this Task's Space with named sheets, headings and rows. Use strings for cells and precomputed numbers for totals. Label calculation methods; formula-like text is stored as text for safety. Supply all source data; label assumptions. Each call saves a new copy. Returns a relative file path: link it in your response.",
  parameters: Schema.Struct({
    title: Title,
    sheets: Schema.Array(
      Schema.Struct({
        name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(31)),
        rows: Schema.Array(
          Schema.Array(Schema.String.check(Schema.isMaxLength(1000))).check(
            Schema.isMaxLength(100),
          ),
        ).check(Schema.isMaxLength(2000)),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  }),
  success: Result,
  failure: Schema.Union([OutputFailedError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Create spreadsheet")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const presentation = Tool.make("create_presentation", {
  description:
    "Create an editable PowerPoint presentation with simple slides using Doer's bundled tools. Keep each slide to one idea, concise bullet points and optional speaker notes. Include sources and dates in notes or a source slide. Each call saves a new copy. Returns a relative file path: link it in your response.",
  parameters: Schema.Struct({
    title: Title,
    slides: Schema.Array(
      Schema.Struct({
        title: Title,
        points: Schema.Array(Schema.String.check(Schema.isMaxLength(500))).check(
          Schema.isMaxLength(8),
        ),
        notes: Schema.optional(Text),
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  }),
  success: Result,
  failure: Schema.Union([OutputFailedError, OrchestratorMcpFailure]),
  dependencies,
})
  .annotate(Tool.Title, "Create presentation")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
export const OutputsToolkit = Toolkit.make(document, spreadsheet, presentation);
