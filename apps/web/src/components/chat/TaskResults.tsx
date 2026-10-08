import { useMemo, useState } from "react";
import { FileIcon } from "lucide-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAssetUrlRefresh } from "~/assets/assetUrls";
import { useComposerHandleContext } from "~/composerHandleContext";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildRepeatTaskPrompt } from "./taskResultsPerTurn";
import { cn } from "~/lib/utils";

export function TaskResults(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  paths: readonly string[];
  layout?: "page" | "inline";
  onOpen: (path: string) => void;
  onSources: () => void;
}) {
  const paths = props.paths;
  const composer = useComposerHandleContext();
  const [message, setMessage] = useState<string | null>(null);
  const insert = (text: string) => {
    if (!composer?.current?.insertTextAtEnd(text, { ensureLeadingBoundary: true })) {
      setMessage("Use the message box to request a revision or repeat this work.");
      return;
    }
    composer.current.focusAtEnd();
    setMessage("Review the request in the message box, then send it.");
  };
  if (paths.length === 0) return null;
  const inline = props.layout === "inline";
  return (
    <section
      aria-label="Task results"
      className={cn(
        "@container/task-results flex w-full flex-col gap-3",
        inline ? "py-1" : "mx-auto max-w-(--chat-max-width) py-4",
      )}
    >
      {paths.length ? (
        <>
          <h3 className="text-sm font-medium">
            Your files{" "}
            <span className="ml-1 text-xs font-normal text-muted-foreground">{paths.length}</span>
          </h3>
          <div className="divide-y overflow-hidden rounded-xl border">
            {paths.map((path) => (
              <OutputFile
                key={path}
                environmentId={props.environmentId}
                threadId={props.threadId}
                path={path}
                onOpen={props.onOpen}
                onRevise={() =>
                  insert(
                    `Please revise ${path}. Show the changes and save a new copy without changing the original. The changes I want are: `,
                  )
                }
              />
            ))}
          </div>
        </>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="ghost" onClick={props.onSources}>
          Sources & explanation
        </Button>
        <Button size="sm" variant="ghost" onClick={() => insert(buildRepeatTaskPrompt(paths))}>
          Repeat this work
        </Button>
      </div>
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </section>
  );
}
function OutputFile(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  path: string;
  onOpen: (path: string) => void;
  onRevise: () => void;
}) {
  const filename = props.path.split("/").at(-1) ?? "Output";
  const extension = filename.split(".").at(-1)?.toLowerCase() ?? "";
  const title = filename.replace(/-[a-f0-9]{8}(?=\.[^.]+$)/i, "").replace(/\.[^.]+$/, "");
  const typeLabel = OUTPUT_TYPE_LABELS[extension] ?? extension.toUpperCase();
  const resource = useMemo(
    () => ({ _tag: "workspace-file" as const, threadId: props.threadId, path: props.path }),
    [props.threadId, props.path],
  );
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function saveCopy() {
    setBusy(true);
    setError(null);
    try {
      const url = await refresh();
      if (!url) throw new Error("Reconnect this computer to save a copy.");
      const response = await fetch(url);
      if (!response.ok)
        throw new Error("The file could not be read. Open Files to check it still exists.");
      const blob = await response.blob();
      const target = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = target;
      link.download = props.path.split("/").at(-1) ?? "Output";
      link.click();
      setTimeout(() => URL.revokeObjectURL(target), 30_000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this copy. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex min-w-0 flex-col gap-3 @min-[32rem]/task-results:flex-row @min-[32rem]/task-results:items-center">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
            <FileIcon className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <Tooltip>
              <TooltipTrigger render={<p className="truncate text-sm font-medium" />}>
                {title}
              </TooltipTrigger>
              <TooltipPopup>{filename}</TooltipPopup>
            </Tooltip>
            <p className="text-xs text-muted-foreground">{typeLabel}</p>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-1.5">
          <Button size="sm" variant="outline" onClick={() => props.onOpen(props.path)}>
            Open
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void saveCopy()}>
            {busy ? "Saving…" : "Save a copy"}
          </Button>
          <Button size="sm" variant="ghost" onClick={props.onRevise}>
            Revise
          </Button>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const OUTPUT_TYPE_LABELS: Readonly<Record<string, string>> = {
  docx: "Word document",
  pptx: "Presentation",
  xlsx: "Spreadsheet",
  pdf: "PDF",
  html: "Web page",
  csv: "CSV spreadsheet",
  txt: "Text document",
  md: "Markdown document",
};
