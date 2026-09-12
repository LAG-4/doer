import type { EnvironmentId } from "@t3tools/contracts";
import {
  base64ToBytes,
  bytesToBase64,
  isSpreadsheetRuntimeSupported,
  parseSpreadsheet,
  serializeSpreadsheet,
  spreadsheetGridsEqual,
} from "@t3tools/shared/spreadsheetWorkbook";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CopyIcon, DownloadIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { readLocalApi } from "~/localApi";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

import { SpreadsheetGridEditor } from "./SpreadsheetGridEditor";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { useProjectBinaryFileQuery } from "./projectFilesQueryState";
import {
  collectSpreadsheetFormulas,
  evaluateSpreadsheetFormulas,
  loadSpreadsheetFormulaEngine,
  type SpreadsheetFormulaEngine,
} from "./spreadsheetFormulas";
import {
  addSpreadsheetColumn,
  addSpreadsheetRow,
  applySpreadsheetSave,
  createSpreadsheetDocument,
  deleteSpreadsheetRow,
  discardSpreadsheetChanges,
  isSpreadsheetDirty,
  setSpreadsheetCell,
  spreadsheetGridToTsv,
  type SpreadsheetDocument,
} from "./spreadsheetModel";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";

interface SpreadsheetSurfaceProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly workspaceMutationId: string | null;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  /** True when the host can open files in an external app (Excel). */
  readonly canOpenInExternalApp: boolean;
}

export function SpreadsheetSurface({
  environmentId,
  cwd,
  relativePath,
  workspaceMutationId,
  onPendingChange,
  canOpenInExternalApp,
}: SpreadsheetSurfaceProps) {
  const file = useProjectBinaryFileQuery(environmentId, cwd, relativePath, true);
  const [document, setDocument] = useState<SpreadsheetDocument | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [formulaEngine, setFormulaEngine] = useState<SpreadsheetFormulaEngine | null>(null);
  const documentRef = useRef<SpreadsheetDocument | null>(null);
  const displaysRef = useRef<string[][] | null>(null);
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
  const formulas = useMemo(() => collectSpreadsheetFormulas(document?.rows ?? []), [document]);

  // The formula engine loads lazily, only for sheets that contain formulas.
  useEffect(() => {
    if (formulas.length === 0 || formulaEngine) return;
    let cancelled = false;
    void loadSpreadsheetFormulaEngine().then(
      (engine) => {
        if (!cancelled) setFormulaEngine(engine);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [formulas, formulaEngine]);

  // Display grid: formula cells show live computed values, everything else
  // passes through. Without an engine the raw text shows, as before.
  const displays = useMemo(() => {
    if (!document) return null;
    if (formulas.length === 0 || !formulaEngine) return document.rows;
    try {
      return evaluateSpreadsheetFormulas(
        document.rows,
        formulas,
        document.sheetName,
        formulaEngine,
      );
    } catch {
      return document.rows;
    }
  }, [document, formulas, formulaEngine]);

  useEffect(() => {
    displaysRef.current = displays;
  }, [displays]);

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
      const displayGrid = displaysRef.current ?? current.rows;
      const bytes = await serializeSpreadsheet(current.sourceBytes, current.rows, displayGrid);
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

  const openFileInExternalApp = useAtomCommand(shellEnvironment.openFile, {
    label: "open in excel",
    reportFailure: false,
  });

  const handleOpenInExcel = useCallback(async () => {
    if (saveInFlightRef.current || !documentRef.current) return;
    // Excel opens the bytes on disk, not the grid: confirm instead of
    // silently opening stale data.
    if (dirtyRef.current) {
      const localApi = readLocalApi();
      const confirmed =
        (await localApi?.dialogs.confirm(
          "Open the saved file in Excel? Unsaved changes won't be included.",
        )) ?? false;
      if (!confirmed) return;
    }
    const result = await openFileInExternalApp({ environmentId, input: { cwd, relativePath } });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't open in Excel",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
      return;
    }
    toastManager.add({ type: "success", title: "Opened in Excel" });
  }, [cwd, environmentId, openFileInExternalApp, relativePath]);

  const handleDownload = useCallback(async () => {
    const current = documentRef.current;
    if (!current) return;
    const baseName = relativePath.split(/[\\/]/).at(-1)?.trim() || "sheet.xlsx";
    try {
      const displayGrid = displaysRef.current ?? current.rows;
      const bytes = await serializeSpreadsheet(current.sourceBytes, current.rows, displayGrid);
      const url = URL.createObjectURL(
        new Blob([bytes.slice().buffer as ArrayBuffer], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      try {
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = baseName;
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
      toastManager.add({ type: "success", title: "Download started" });
    } catch {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't download this sheet",
          description: "The spreadsheet couldn't be packed up. Try again.",
        }),
      );
    }
  }, [relativePath]);

  const handleCopySheet = useCallback(async () => {
    const current = documentRef.current;
    if (!current) return;
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable");
      }
      const displayGrid = displaysRef.current ?? current.rows;
      await navigator.clipboard.writeText(spreadsheetGridToTsv(displayGrid));
      toastManager.add({
        type: "success",
        title: "Copied — paste into Excel or Google Sheets",
      });
    } catch {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't copy this sheet",
          description: "Clipboard access was denied. Download the file instead.",
        }),
      );
    }
  }, []);

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
        {canOpenInExternalApp ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => void handleOpenInExcel()}
                  aria-label="Open in Excel"
                >
                  <ExternalLinkIcon className="size-3.5" />
                  Excel
                </Button>
              }
            />
            <TooltipPopup>Open the saved file in Excel</TooltipPopup>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void handleDownload()}
                aria-label="Download spreadsheet"
              >
                <DownloadIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup>Download spreadsheet</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void handleCopySheet()}
                aria-label="Copy sheet for Excel or Google Sheets"
              >
                <CopyIcon className="size-3.5" />
              </Button>
            }
          />
          <TooltipPopup>Copy sheet for Excel or Google Sheets</TooltipPopup>
        </Tooltip>
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
          grid={displays ?? document.rows}
          rawGrid={document.rows}
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
