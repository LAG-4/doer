import {
  normalizeSpreadsheetGrid,
  spreadsheetGridsEqual,
} from "@t3tools/shared/spreadsheetWorkbook";

export type SpreadsheetGrid = string[][];

export interface SpreadsheetDocument {
  readonly sheetName: string;
  readonly sheetNames: string[];
  readonly savedRows: SpreadsheetGrid;
  readonly rows: SpreadsheetGrid;
  /** Original workbook bytes; other sheets are preserved from these on save. */
  readonly sourceBytes: Uint8Array;
}

export function createSpreadsheetDocument(input: {
  readonly sheetName: string;
  readonly sheetNames: string[];
  readonly rows: SpreadsheetGrid;
  readonly sourceBytes: Uint8Array;
}): SpreadsheetDocument {
  const rows = normalizeSpreadsheetGrid(input.rows);
  return {
    sheetName: input.sheetName,
    sheetNames: input.sheetNames,
    savedRows: rows,
    rows,
    sourceBytes: input.sourceBytes,
  };
}

export function isSpreadsheetDirty(document: SpreadsheetDocument): boolean {
  return !spreadsheetGridsEqual(document.savedRows, document.rows);
}

export function setSpreadsheetCell(
  document: SpreadsheetDocument,
  rowIndex: number,
  colIndex: number,
  value: string,
): SpreadsheetDocument {
  if (rowIndex < 0 || colIndex < 0) return document;
  const rows = document.rows.map((row) => [...row]);
  while (rows.length <= rowIndex) {
    const width = rows[0]?.length ?? colIndex + 1;
    rows.push(Array.from({ length: width }, () => ""));
  }
  const row = rows[rowIndex];
  if (!row) return document;
  while (row.length <= colIndex) row.push("");
  row[colIndex] = value;
  return { ...document, rows: normalizeSpreadsheetGrid(rows) };
}

export function addSpreadsheetRow(document: SpreadsheetDocument): SpreadsheetDocument {
  const width = document.rows[0]?.length ?? 1;
  return {
    ...document,
    rows: [...document.rows, Array.from({ length: width }, () => "")],
  };
}

export function addSpreadsheetColumn(document: SpreadsheetDocument): SpreadsheetDocument {
  if (document.rows.length === 0) {
    return { ...document, rows: [[""]] };
  }
  return { ...document, rows: document.rows.map((row) => [...row, ""]) };
}

export function deleteSpreadsheetRow(
  document: SpreadsheetDocument,
  rowIndex: number,
): SpreadsheetDocument {
  if (rowIndex < 0 || rowIndex >= document.rows.length) return document;
  return {
    ...document,
    rows: document.rows.filter((_, index) => index !== rowIndex),
  };
}

/** Discard restores the last-saved grid. */
export function discardSpreadsheetChanges(document: SpreadsheetDocument): SpreadsheetDocument {
  return { ...document, rows: document.savedRows.map((row) => [...row]) };
}

/**
 * Tab-separated values for the clipboard: paste straight into Excel or
 * Google Sheets and the grid survives. Cells holding tabs, newlines, or
 * quotes are quoted with doubled quotes, mirroring CSV conventions.
 */
export function spreadsheetGridToTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          const text = cell ?? "";
          if (!/[\t\n\r"]/.test(text)) return text;
          return `"${text.replace(/"/g, '""')}"`;
        })
        .join("\t"),
    )
    .join("\n");
}

/**
 * Snapshot a confirmed write. The live grid is kept as-is: edits typed while
 * the save was in flight stay dirty against the new snapshot instead of
 * being clobbered by it.
 */
export function applySpreadsheetSave(
  document: SpreadsheetDocument,
  savedRows: SpreadsheetGrid,
  sourceBytes: Uint8Array,
): SpreadsheetDocument {
  return {
    ...document,
    savedRows: normalizeSpreadsheetGrid(savedRows),
    sourceBytes,
  };
}
