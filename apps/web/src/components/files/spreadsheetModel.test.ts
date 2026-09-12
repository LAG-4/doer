import { describe, expect, it } from "vite-plus/test";

import {
  addSpreadsheetColumn,
  addSpreadsheetRow,
  applySpreadsheetSave,
  createSpreadsheetDocument,
  deleteSpreadsheetRow,
  discardSpreadsheetChanges,
  isSpreadsheetDirty,
  setSpreadsheetCell,
} from "./spreadsheetModel";

function makeDocument(rows: string[][] = [["a", "b"]]) {
  return createSpreadsheetDocument({
    sheetName: "Budget",
    sheetNames: ["Budget"],
    rows,
    sourceBytes: new Uint8Array([1, 2, 3]),
  });
}

describe("spreadsheet model", () => {
  it("starts clean with a normalized rectangle", () => {
    const document = makeDocument([["a"], ["b", "c"]]);
    expect(document.rows).toEqual([
      ["a", ""],
      ["b", "c"],
    ]);
    expect(isSpreadsheetDirty(document)).toBe(false);
  });

  it("tracks dirty state through edits", () => {
    const edited = setSpreadsheetCell(makeDocument(), 0, 0, "CHANGED");
    expect(edited.rows[0]?.[0]).toBe("CHANGED");
    expect(isSpreadsheetDirty(edited)).toBe(true);
  });

  it("returns to clean when an edit is reverted", () => {
    const document = makeDocument();
    const edited = setSpreadsheetCell(document, 0, 0, "CHANGED");
    expect(isSpreadsheetDirty(setSpreadsheetCell(edited, 0, 0, "a"))).toBe(false);
  });

  it("grows the grid when editing past its edges", () => {
    const edited = setSpreadsheetCell(makeDocument([["a"]]), 2, 2, "corner");
    expect(edited.rows).toEqual([
      ["a", "", ""],
      ["", "", ""],
      ["", "", "corner"],
    ]);
    expect(isSpreadsheetDirty(edited)).toBe(true);
  });

  it("adds columns, seeding an empty grid with one cell", () => {
    expect(addSpreadsheetColumn(makeDocument([["a", "b"]])).rows).toEqual([["a", "b", ""]]);
    const seeded = addSpreadsheetColumn(makeDocument([]));
    expect(seeded.rows).toEqual([[""]]);
    expect(isSpreadsheetDirty(seeded)).toBe(true);
  });

  it("adds and deletes rows", () => {
    const added = addSpreadsheetRow(makeDocument([["a", "b"]]));
    expect(added.rows).toEqual([
      ["a", "b"],
      ["", ""],
    ]);
    expect(isSpreadsheetDirty(added)).toBe(true);
    const deleted = deleteSpreadsheetRow(added, 0);
    expect(deleted.rows).toEqual([["", ""]]);
    expect(deleteSpreadsheetRow(makeDocument(), 9)).toEqual(makeDocument());
  });

  it("discards edits back to the last-saved grid", () => {
    const document = makeDocument();
    const edited = addSpreadsheetRow(setSpreadsheetCell(document, 0, 1, "CHANGED"));
    expect(isSpreadsheetDirty(edited)).toBe(true);
    const discarded = discardSpreadsheetChanges(edited);
    expect(discarded.rows).toEqual(document.savedRows);
    expect(isSpreadsheetDirty(discarded)).toBe(false);
    expect(discarded.sourceBytes).toBe(document.sourceBytes);
  });

  it("snapshots saved bytes without clobbering newer edits", () => {
    const document = makeDocument();
    const edited = setSpreadsheetCell(document, 0, 0, "CHANGED");
    const nextBytes = new Uint8Array([9, 9]);
    const confirmed = applySpreadsheetSave(edited, edited.rows, nextBytes);
    expect(isSpreadsheetDirty(confirmed)).toBe(false);
    expect(confirmed.savedRows).toEqual([["CHANGED", "b"]]);
    expect(confirmed.sourceBytes).toBe(nextBytes);
    // An edit typed while the save was in flight stays dirty afterwards.
    const duringSave = setSpreadsheetCell(edited, 0, 1, "NEWER");
    const confirmedLater = applySpreadsheetSave(duringSave, edited.rows, nextBytes);
    expect(confirmedLater.rows).toEqual([["CHANGED", "NEWER"]]);
    expect(isSpreadsheetDirty(confirmedLater)).toBe(true);
  });
});
