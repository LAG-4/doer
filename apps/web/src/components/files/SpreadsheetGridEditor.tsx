import { columnIndexToLetters } from "@t3tools/shared/spreadsheetWorkbook";
import { Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

interface SpreadsheetGridEditorProps {
  readonly grid: readonly (readonly string[])[];
  /**
   * Raw grid text behind the display grid, powering the formula bar. The
   * grid always shows display values; the bar owns the raw text, so inputs
   * never flip values under the cursor.
   */
  readonly rawGrid?: readonly (readonly string[])[];
  readonly readOnly?: boolean;
  readonly onCellChange?: (rowIndex: number, colIndex: number, value: string) => void;
  readonly onAddRow?: () => void;
  readonly onAddColumn?: () => void;
  readonly onDeleteRow?: (rowIndex: number) => void;
}

export function SpreadsheetGridEditor({
  grid,
  rawGrid,
  readOnly = false,
  onCellChange,
  onAddRow,
  onAddColumn,
  onDeleteRow,
}: SpreadsheetGridEditorProps) {
  const columnCount = grid.reduce((max, row) => Math.max(max, row.length), 0);
  const columns = Array.from({ length: Math.max(columnCount, 1) }, (_, index) => index);
  // Selected cell for the formula bar (Excel-style: grid shows values, the
  // bar shows raw text). Null until the user picks a cell.
  const [selected, setSelected] = useState<{ row: number; col: number } | null>(null);
  const showFormulaBar = !readOnly && rawGrid !== undefined && onCellChange !== undefined;
  const selectedRaw =
    selected === null || !showFormulaBar ? "" : (rawGrid?.[selected.row]?.[selected.col] ?? "");
  const selectedRef =
    selected === null ? "" : `${columnIndexToLetters(selected.col)}${selected.row + 1}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {showFormulaBar ? (
        <div className="flex h-9 min-h-9 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <span className="shrink-0 text-[11px] font-medium text-muted-foreground">fx</span>
          {selected === null ? (
            <span className="truncate text-xs text-muted-foreground">
              Select a cell to see its formula
            </span>
          ) : (
            <>
              <span className="shrink-0 text-[11px] text-muted-foreground">{selectedRef}</span>
              <input
                value={selectedRaw}
                onChange={(event) => onCellChange?.(selected.row, selected.col, event.target.value)}
                aria-label={`Formula for ${selectedRef}`}
                placeholder="Type a value or formula starting with ="
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
              />
            </>
          )}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10">
            <tr>
              {/* Sticky headers need an opaque background: the theme's muted
                  tint is translucent, so scrolled data bleeds through it. */}
              <th className="sticky left-0 w-10 min-w-10 border-r border-b border-border/60 bg-background px-1 py-1 text-center text-[11px] font-medium text-muted-foreground">
                <span className="sr-only">Row</span>
              </th>
              {columns.map((colIndex) => (
                <th
                  key={columnIndexToLetters(colIndex)}
                  scope="col"
                  className="min-w-28 border-r border-b border-border/60 bg-background px-2 py-1 text-center text-[11px] font-medium text-muted-foreground"
                >
                  {columnIndexToLetters(colIndex)}
                </th>
              ))}
              {readOnly ? null : (
                <th className="w-10 min-w-10 border-b border-border/60 bg-background" />
              )}
            </tr>
          </thead>
          <tbody>
            {/* Rows are positional data (the header shows row numbers), so the
                index is the stable identity here. */}
            {grid.map((row, rowIndex) => (
              <tr key={rowIndex} className="group/row">
                <th
                  scope="row"
                  className="sticky left-0 border-r border-b border-border/60 bg-background px-1 py-0.5 text-center text-[11px] font-medium text-muted-foreground"
                >
                  {rowIndex + 1}
                </th>
                {columns.map((colIndex) => (
                  <td
                    key={columnIndexToLetters(colIndex)}
                    className="border-r border-b border-border/60 p-0"
                  >
                    <input
                      value={row[colIndex] ?? ""}
                      disabled={readOnly}
                      onChange={(event) => onCellChange?.(rowIndex, colIndex, event.target.value)}
                      onFocus={() => setSelected({ row: rowIndex, col: colIndex })}
                      aria-label={`Row ${rowIndex + 1}, column ${columnIndexToLetters(colIndex)}`}
                      className={cn(
                        "h-8 w-full min-w-28 bg-transparent px-2 text-sm outline-none",
                        "placeholder:text-muted-foreground/50",
                        "focus:bg-accent/50 disabled:cursor-default",
                        selected !== null &&
                          selected.row === rowIndex &&
                          selected.col === colIndex &&
                          "bg-accent/30",
                      )}
                    />
                  </td>
                ))}
                {readOnly ? null : (
                  <td className="border-b border-border/60 p-0 text-center">
                    <button
                      type="button"
                      onClick={() => onDeleteRow?.(rowIndex)}
                      aria-label={`Delete row ${rowIndex + 1}`}
                      className="mx-auto flex size-6 items-center justify-center rounded-sm text-muted-foreground opacity-0 group-hover/row:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100"
                    >
                      <X className="size-3.5" />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {grid.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-muted-foreground">
            This sheet is empty. Add a row to get started.
          </p>
        ) : null}
      </div>
      {readOnly || (!onAddRow && !onAddColumn) ? null : (
        <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-2">
          {onAddRow ? (
            <Button variant="ghost" size="xs" onClick={onAddRow}>
              <Plus className="size-3.5" />
              Add row
            </Button>
          ) : null}
          {onAddColumn ? (
            <Button variant="ghost" size="xs" onClick={onAddColumn}>
              <Plus className="size-3.5" />
              Add column
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
