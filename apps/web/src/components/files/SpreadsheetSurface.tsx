import type { EnvironmentId } from "@t3tools/contracts";
import {
  base64ToBytes,
  bytesToBase64,
  isSpreadsheetRuntimeSupported,
  parseSpreadsheet,
  serializeSpreadsheet,
  spreadsheetGridsEqual,
} from "@t3tools/shared/spreadsheetWorkbook";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { readLocalApi } from "~/localApi";

import { SpreadsheetGridEditor } from "./SpreadsheetGridEditor";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { useProjectBinaryFileQuery } from "./projectFilesQueryState";
import {
  addSpreadsheetColumn,
  addSpreadsheetRow,
  applySpreadsheetSave,
  createSpreadsheetDocument,
  deleteSpreadsheetRow,
  discardSpreadsheetChanges,
  isSpreadsheetDirty,
  setSpreadsheetCell,
  type SpreadsheetDocument,
} from "./spreadsheetModel";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

interface SpreadsheetSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly workspaceMutationId: string | null;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function SpreadsheetSurface({
  environmentId,
  cwd,
  relativePath,
  workspaceMutationId,
  onPendingChange,
}: SpreadsheetSurfaceProps) {
  const file = useProjectBinaryFileQuery(environmentId, cwd, relativePath, true);
  const [document, setDocument] = useState<SpreadsheetDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const documentRef = useRef<SpreadsheetDocument | null>(null);
  const parseRequestRef = useRef(0);
  const pendingSaveRef = useRef<{
    base64: string;
    rows: string[][];
    bytes: Uint8Array;
  } | null>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dirty = document ? isSpreadsheetDirty(document) : false;
  const dirtyRef = useRef(false);
  const saveInFlightRef = useRef(false);

  useEffect(() => {
    documentRef.current = document;
  }, [document]);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    saveInFlightRef.current = saveInFlight;
  }, [saveInFlight]);

  // The surface reports pending from its edit and save handlers. A goodbye
  // report on unmount keeps the tab dot from going stale.
  useEffect(() => {
    return () => {
      onPendingChange(relativePath, false);
    };
  }, [onPendingChange, relativePath]);

  useWorkspaceMutationRefresh({
    enabled: !dirty && !saveInFlight,
    mutationId: workspaceMutationId,
    refresh: file.refresh,
    resourceKey: `spreadsheet:${environmentId}:${cwd}:${relativePath}`,
  });

  useEffect(() => {
    if (file.data === null || file.data.truncated) return;
    // Never clobber unsaved edits with a background refresh.
    if (dirtyRef.current) return;
    if (file.data.encoding !== undefined && file.data.encoding !== "base64") return;
    const requestId = (parseRequestRef.current += 1);
    let cancelled = false;
    void (async () => {
      try {
        const bytes = base64ToBytes(file.data?.contents ?? "");
        const parsed = await parseSpreadsheet(bytes);
        if (cancelled || parseRequestRef.current !== requestId) return;
        setLoadError(null);
        setDocument(
          createSpreadsheetDocument({
            sheetName: parsed.activeSheetName,
            sheetNames: parsed.sheetNames,
            rows: parsed.rows,
            sourceBytes: bytes,
          }),
        );
      } catch (error) {
        if (cancelled || parseRequestRef.current !== requestId) return;
        setLoadError(
          error instanceof Error && error.message
            ? error.message
            : "This spreadsheet couldn't be opened. The file may be corrupt.",
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file.data]);

  const handleSaved = useCallback(
    (contents: string) => {
      const pending = pendingSaveRef.current;
      if (!pending || pending.base64 !== contents) {
        setSaveInFlight(false);
        return;
      }
      pendingSaveRef.current = null;
      setSaveInFlight(false);
      const liveRows = documentRef.current?.rows;
      setDocument((current) =>
        current ? applySpreadsheetSave(current, pending.rows, pending.bytes) : current,
      );
      // Edits typed while the save was in flight stay pending.
      onPendingChange(relativePath, !spreadsheetGridsEqual(pending.rows, liveRows ?? pending.rows));
    },
    [onPendingChange, relativePath],
  );

  const saveCoordinatorRef = useRef<{ save: (contents: string) => void } | null>(null);

  const handleSave = useCallback(async () => {
    const current = documentRef.current;
    if (!current || !isSpreadsheetDirty(current) || saveInFlightRef.current) return;
    setSaveInFlight(true);
    onPendingChange(relativePath, true);
    try {
      const bytes = await serializeSpreadsheet(current.sourceBytes, current.rows);
      const base64 = bytesToBase64(bytes);
      pendingSaveRef.current = { base64, rows: current.rows, bytes };
      saveCoordinatorRef.current?.save(base64);
    } catch {
      pendingSaveRef.current = null;
      setSaveInFlight(false);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't save this sheet",
          description: "The changes couldn't be packed back into the spreadsheet file.",
        }),
      );
    }
  }, [onPendingChange, relativePath]);

  const handleSaveError = useCallback(() => {
    setSaveInFlight(false);
    onPendingChange(relativePath, true);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Couldn't save this sheet",
        description: "Check your connection and try again.",
        actionProps: {
          children: "Retry",
          onClick: () => {
            void handleSave();
          },
        },
      }),
    );
  }, [handleSave, onPendingChange, relativePath]);

  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange,
    binaryEncoding: "base64",
    onSaved: handleSaved,
    onSaveError: handleSaveError,
  });

  useEffect(() => {
    saveCoordinatorRef.current = saveCoordinator;
  }, [saveCoordinator]);

  const handleDiscard = useCallback(() => {
    setDocument((current) => (current ? discardSpreadsheetChanges(current) : current));
    onPendingChange(relativePath, false);
  }, [onPendingChange, relativePath]);

  const applyEdit = useCallback(
    (edit: (current: SpreadsheetDocument) => SpreadsheetDocument) => {
      const current = documentRef.current;
      if (!current) return;
      const next = edit(current);
      setDocument(next);
      onPendingChange(relativePath, isSpreadsheetDirty(next));
    },
    [onPendingChange, relativePath],
  );

  const confirmDiscard = useCallback(async () => {
    if (!dirtyRef.current || saveInFlightRef.current) return;
    const localApi = readLocalApi();
    const confirmed =
      (await localApi?.dialogs.confirm("Discard unsaved changes to this sheet?")) ?? false;
    if (confirmed) handleDiscard();
  }, [handleDiscard]);

  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor: { setSelections: () => undefined },
      isBlocked: () => !dirtyRef.current || saveInFlightRef.current,
      onDismiss: () => {
        void confirmDiscard();
      },
    });
  }, [confirmDiscard]);

  const extraSheets = useMemo(
    () => Math.max(0, (document?.sheetNames.length ?? 1) - 1),
    [document],
  );

  if (!isSpreadsheetRuntimeSupported()) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground">
        Sheets need a newer browser runtime with compression support.
      </div>
    );
  }

  return (
    <div ref={surfaceRef} className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex h-9 min-h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="rounded-sm bg-accent px-1.5 py-0.5 text-[11px] font-medium">Sheet</span>
        {document ? (
          <span className="truncate text-xs text-muted-foreground">
            {document.sheetName}
            {extraSheets > 0
              ? ` · ${extraSheets} more sheet${extraSheets === 1 ? "" : "s"} kept`
              : ""}
          </span>
        ) : null}
        <span className="min-w-0 flex-1" />
        {dirty && !saveInFlight ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            Unsaved changes
          </span>
        ) : null}
        {saveInFlight ? (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Spinner className="size-3" />
            Saving
          </span>
        ) : null}
        {dirty && !saveInFlight ? (
          <Button variant="ghost" size="xs" onClick={handleDiscard}>
            Discard changes
          </Button>
        ) : null}
        <Button size="xs" disabled={!dirty || saveInFlight} onClick={() => void handleSave()}>
          Save
        </Button>
      </div>
      {file.error && file.data === null ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
          {file.error}
        </div>
      ) : file.data?.truncated ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-muted-foreground">
          This spreadsheet is too large to edit here.
        </div>
      ) : loadError ? (
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
          {loadError}
        </div>
      ) : !document ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      ) : (
        <SpreadsheetGridEditor
          grid={document.rows}
          onCellChange={(rowIndex, colIndex, value) =>
            applyEdit((current) => setSpreadsheetCell(current, rowIndex, colIndex, value))
          }
          onAddRow={() => applyEdit((current) => addSpreadsheetRow(current))}
          onAddColumn={() => applyEdit((current) => addSpreadsheetColumn(current))}
          onDeleteRow={(rowIndex) =>
            applyEdit((current) => deleteSpreadsheetRow(current, rowIndex))
          }
        />
      )}
    </div>
  );
}
