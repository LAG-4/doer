import * as McpToolAccess from "../../McpToolAccess.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { requireDoerThreadScope } from "../../McpInvocationContext.ts";
import { DoerTaskContext as ProjectionSnapshotQuery } from "../../../memory/DoerTaskContext.ts";
import { WorkspaceFileSystem } from "../../../workspace/WorkspaceFileSystem.ts";
import { generateDocument, generatePresentation, generateSpreadsheet } from "./generate.ts";
import { OutputFailedError, OutputsToolkit } from "./tools.ts";

export const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const files = yield* WorkspaceFileSystem;
  const save = Effect.fn("Outputs.save")(function* (
    title: string,
    format: "docx" | "xlsx" | "pptx",
    generate: () => Promise<Uint8Array>,
  ) {
    const scope = yield* requireDoerThreadScope;
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
      catch: (cause) =>
        new OutputFailedError({
          detail:
            cause instanceof Error && cause.message.trim().length > 0
              ? cause.message.trim().slice(0, 300)
              : "Check the content and try a smaller file.",
        }),
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

export const layer = McpToolAccess.toLayer(
  OutputsToolkit,
  make.pipe(
    Effect.map((handlers) => ({
      create_document: McpToolAccess.actsAsCaller(handlers.create_document),
      create_spreadsheet: McpToolAccess.actsAsCaller(handlers.create_spreadsheet),
      create_presentation: McpToolAccess.actsAsCaller(handlers.create_presentation),
    })),
  ),
);
