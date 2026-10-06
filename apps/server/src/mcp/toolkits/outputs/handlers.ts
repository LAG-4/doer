// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";
import { generateDocument, generatePresentation, generateSpreadsheet } from "./generate.ts";
import { OutputFailedError, OutputsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const files = yield* WorkspaceFileSystem;
  const save = Effect.fn("Outputs.save")(function* (
    title: string,
    format: "docx" | "xlsx" | "pptx",
    generate: () => Promise<Uint8Array>,
  ) {
    const scope = yield* McpInvocationContext;
    const context = yield* snapshots
      .getThreadCheckpointContext(scope.threadId)
      .pipe(
        Effect.mapError(
          () => new OutputFailedError({ detail: "This Task's Space could not be loaded." }),
        ),
      );
    if (Option.isNone(context))
      return yield* new OutputFailedError({ detail: "This Task is no longer available." });
    const bytes = yield* Effect.tryPromise({
      try: generate,
      catch: () => new OutputFailedError({ detail: "Check the content and try a smaller file." }),
    });
    const stem =
      title
        .normalize("NFKC")
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .trim()
        .slice(0, 80) || "Output";
    const relativePath = `Outputs/${stem}-${NodeCrypto.randomUUID().slice(0, 8)}.${format}`;
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
            new OutputFailedError({
              detail:
                "The file could not be saved in this Space. Check folder access and available storage.",
            }),
        ),
      );
    return { relativePath, format };
  });
  return OutputsToolkit.of({
    create_document: (input) => save(input.title, "docx", () => generateDocument(input)),
    create_spreadsheet: (input) =>
      save(input.title, "xlsx", () => generateSpreadsheet(input.sheets)),
    create_presentation: (input) => save(input.title, "pptx", () => generatePresentation(input)),
  });
});
export const OutputsToolkitHandlersLive = OutputsToolkit.toLayer(make);
