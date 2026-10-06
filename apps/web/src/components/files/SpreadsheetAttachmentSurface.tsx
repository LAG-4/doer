import type { ChatFileAttachment, EnvironmentId } from "@t3tools/contracts";
import {
  isSpreadsheetRuntimeSupported,
  parseSpreadsheet,
  type ParsedSpreadsheet,
} from "@t3tools/shared/spreadsheetWorkbook";
import { useEffect, useMemo, useState } from "react";
import { useAssetUrlState } from "~/assets/assetUrls";
import { Spinner } from "~/components/ui/spinner";

import { SpreadsheetGridEditor } from "./SpreadsheetGridEditor";

/**
 * Read-only sheet grid for .xlsx chat attachments. Attachments live in the
 * thread's attachment store rather than at a workspace path, so there is no
 * file to save back to; workspace files use the editable SpreadsheetSurface.
 */
export function SpreadsheetAttachmentSurface({
  environmentId,
  attachment,
}: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatFileAttachment;
}) {
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: attachment.id,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
      disposition: "inline" as const,
    }),
    [attachment.id, attachment.mimeType, attachment.name],
  );
  const assetUrl = useAssetUrlState(environmentId, resource);
  const currentUrl = assetUrl._tag === "Success" ? assetUrl.url : null;
  const [sheetIndex, setSheetIndex] = useState(0);
  const [loaded, setLoaded] = useState<{
    url: string;
    bytes: Uint8Array | null;
    parsed: ParsedSpreadsheet | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (currentUrl === null) return;
    const url = currentUrl;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Attachment fetch failed: ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const parsed = await parseSpreadsheet(bytes, sheetIndex);
        if (!cancelled) setLoaded({ url, bytes, parsed, error: null });
      } catch {
        if (!cancelled) {
          setLoaded({
            url,
            bytes: null,
            parsed: null,
            error: "This spreadsheet couldn't be opened.",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUrl, sheetIndex]);

  const visible = loaded && currentUrl !== null && loaded.url === currentUrl ? loaded : null;

  if (!isSpreadsheetRuntimeSupported()) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground">
        Sheets need a newer browser runtime with compression support.
      </div>
    );
  }
  if (assetUrl._tag === "Failure" || visible?.error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        {visible?.error ?? "Unable to load attachment preview."}
      </div>
    );
  }
  if (visible?.parsed === undefined || visible.parsed === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-9 min-h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="rounded-sm bg-accent px-1.5 py-0.5 text-2xs font-medium">Sheet</span>
        <select
          aria-label="Worksheet"
          value={sheetIndex}
          onChange={(event) => setSheetIndex(Number(event.target.value))}
          className="rounded border border-input bg-background text-xs"
        >
          {visible.parsed.sheetNames.map((name, index) => (
            <option key={name} value={index}>
              {name}
            </option>
          ))}
        </select>
        <span className="truncate text-xs text-muted-foreground">Previewing saved values</span>
      </div>
      <SpreadsheetGridEditor key={sheetIndex} grid={visible.parsed.cachedRows} readOnly />
    </div>
  );
}
