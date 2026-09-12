import { describe, expect, it } from "vite-plus/test";

import {
  base64ToBytes,
  bytesToBase64,
  cellRefToIndexes,
  columnIndexToLetters,
  createSpreadsheet,
  createSpreadsheetWorkbook,
  excelSerialToIso,
  isDateNumberFormat,
  isSpreadsheetRuntimeSupported,
  normalizeSpreadsheetGrid,
  parseSheetGrid,
  parseSpreadsheet,
  serializeSpreadsheet,
  spreadsheetCellInputFromText,
  spreadsheetGridsEqual,
} from "./spreadsheetWorkbook.ts";

describe("spreadsheet runtime", () => {
  it("reports platform zip support", () => {
    expect(isSpreadsheetRuntimeSupported()).toBe(true);
  });
});

describe("spreadsheet base64", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 65, 66, 67]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("rejects malformed payloads", () => {
    expect(() => base64ToBytes("!!!not-base64!!!")).toThrow();
  });
});

describe("spreadsheet grid helpers", () => {
  it("normalizes ragged rows to a rectangle", () => {
    expect(normalizeSpreadsheetGrid([["a", "b"], ["c"], [], ["d", "e", "f"]])).toEqual([
      ["a", "b", ""],
      ["c", "", ""],
      ["", "", ""],
      ["d", "e", "f"],
    ]);
  });

  it("treats missing cells as empty", () => {
    expect(normalizeSpreadsheetGrid(null)).toEqual([]);
    expect(normalizeSpreadsheetGrid([null, undefined])).toEqual([[], []]);
  });

  it("compares grids by value", () => {
    expect(spreadsheetGridsEqual([["a"]], [["a"]])).toBe(true);
    expect(spreadsheetGridsEqual([["a"]], [["b"]])).toBe(false);
    expect(spreadsheetGridsEqual([["a"]], [["a", ""]])).toBe(false);
    expect(spreadsheetGridsEqual([["a"], ["b"]], [["a"]])).toBe(false);
  });

  it("converts between column indexes and letters", () => {
    expect(columnIndexToLetters(0)).toBe("A");
    expect(columnIndexToLetters(25)).toBe("Z");
    expect(columnIndexToLetters(26)).toBe("AA");
    expect(columnIndexToLetters(27)).toBe("AB");
    expect(cellRefToIndexes("B3")).toEqual({ row: 2, col: 1 });
    expect(cellRefToIndexes("AA10")).toEqual({ row: 9, col: 26 });
    expect(cellRefToIndexes("bogus")).toBeNull();
  });
});

describe("sheet cell parsing", () => {
  it("resolves shared strings, inline strings, and plain values", () => {
    const xml =
      `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>Hi</t></is></c>` +
      `<c r="C1"><v>42</v></c><c r="D1" t="str"><v>cached</v></v></c></row>` +
      `<row r="2"><c r="A2"><f>SUM(A1:A1)</f><v/></c></row>` +
      `</sheetData></worksheet>`;
    expect(parseSheetGrid(xml, ["Budget & <plan>"])).toEqual([
      ["Budget & <plan>", "Hi", "42", "cached"],
      ["=SUM(A1:A1)", "", "", ""],
    ]);
  });

  it("reads booleans as TRUE/FALSE and cached formula results as values", () => {
    const xml =
      `<worksheet><sheetData><row r="1">` +
      `<c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c>` +
      `<c r="C1"><f>SUM(A1:B1)</f><v>1</v></c>` +
      `</row></sheetData></worksheet>`;
    expect(parseSheetGrid(xml)).toEqual([["TRUE", "FALSE", "1"]]);
  });

  it("renders date-formatted serials as ISO dates", () => {
    const xml =
      `<worksheet><sheetData><row r="1">` +
      `<c r="A1" s="1"><v>46277</v></c><c r="B1" s="0"><v>46277</v></c>` +
      `</row></sheetData></worksheet>`;
    expect(parseSheetGrid(xml, [], { numberFormats: ["General", "yyyy-mm-dd"] })).toEqual([
      ["2026-09-12", "46277"],
    ]);
    expect(excelSerialToIso(46277)).toBe("2026-09-12");
    expect(excelSerialToIso(0.5)).toBe("12:00:00");
    expect(isDateNumberFormat("yyyy-mm-dd")).toBe(true);
    expect(isDateNumberFormat("General")).toBe(false);
    expect(isDateNumberFormat("@")).toBe(false);
  });

  it("reads namespace-prefixed rows and cells", () => {
    const xml =
      `<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>` +
      `<x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>prefixed</x:t></x:is></x:c></x:row>` +
      `</x:sheetData></x:worksheet>`;
    expect(parseSheetGrid(xml)).toEqual([["prefixed"]]);
  });

  it("reads sparse cells by reference and pads the rectangle", () => {
    const xml =
      `<worksheet><sheetData>` +
      `<row r="1"><c r="A1" t="inlineStr"><is><t>top</t></is></c></row>` +
      `<row r="3"><c r="C3" t="inlineStr"><is><t>corner</t></is></c></row>` +
      `</sheetData></worksheet>`;
    expect(parseSheetGrid(xml)).toEqual([
      ["top", "", ""],
      ["", "", ""],
      ["", "", "corner"],
    ]);
  });

  it("returns an empty grid for sheets without rows", () => {
    expect(parseSheetGrid(`<worksheet><sheetData></sheetData></worksheet>`)).toEqual([]);
  });
});

describe("spreadsheet cell typing", () => {
  it("turns edited text back into typed cells without guessing", () => {
    expect(spreadsheetCellInputFromText("")).toEqual({ kind: "empty" });
    expect(spreadsheetCellInputFromText("12.5")).toEqual({ kind: "number", value: 12.5 });
    expect(spreadsheetCellInputFromText("-3")).toEqual({ kind: "number", value: -3 });
    expect(spreadsheetCellInputFromText("TRUE")).toEqual({ kind: "boolean", value: true });
    expect(spreadsheetCellInputFromText("FALSE")).toEqual({ kind: "boolean", value: false });
    // Ambiguous numerics stay text; text is never promoted to a formula.
    expect(spreadsheetCellInputFromText("02134").kind).toBe("text");
    expect(spreadsheetCellInputFromText("1,000").kind).toBe("text");
    expect(spreadsheetCellInputFromText("=SUM(A1:A2)").kind).toBe("text");
    expect(spreadsheetCellInputFromText("2026-09-12").kind).toBe("text");
  });

  it("keeps numbers and booleans typed across a save", async () => {
    const bytes = await createSpreadsheet([["12.5", "TRUE", "02134", "1,000"]], "Types");
    const resaved = await serializeSpreadsheet(bytes, [["12.5", "TRUE", "02134", "1,000"]]);
    expect((await parseSpreadsheet(resaved)).rows).toEqual([["12.5", "TRUE", "02134", "1,000"]]);
  });

  it("strips illegal control characters instead of emitting invalid XML", async () => {
    const bytes = await createSpreadsheet([["a\bb"]], "Controls");
    expect((await parseSpreadsheet(bytes)).rows).toEqual([["ab"]]);
  });

  it("refuses cells past Excel's text limit with a clear error", async () => {
    const bytes = await createSpreadsheet([["ok"]], "Limits");
    await expect(serializeSpreadsheet(bytes, [["x".repeat(32_768)]])).rejects.toThrow(/32,767/);
  });

  it("refuses grids too large to render as an editable table", async () => {
    const wide = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => "x"));
    const bytes = await createSpreadsheet(wide, "Small");
    await expect(parseSpreadsheet(bytes)).resolves.toMatchObject({ rows: wide });
    const huge = Array.from({ length: 501 }, () => Array.from({ length: 500 }, () => "x"));
    const hugeBytes = await createSpreadsheet(huge, "Huge");
    await expect(parseSpreadsheet(hugeBytes)).rejects.toThrow(/too large/);
  });
});

describe("spreadsheet round-trip", () => {
  it("creates a workbook that parses back with identical values", async () => {
    const grid = [
      ["Name", "Cost & tax", "Notes <none>"],
      ["Apples", "12.5", 'Say "hi"'],
      ["", "", ""],
      ["Ünïcodé ✓", "2026-09-12", "trailing"],
    ];
    const bytes = await createSpreadsheet(grid, "Budget");
    const parsed = await parseSpreadsheet(bytes);
    expect(parsed.sheetNames).toEqual(["Budget"]);
    expect(parsed.activeSheetName).toBe("Budget");
    expect(parsed.rows).toEqual(grid);
  });

  it("preserves values across parse, serialize, and parse", async () => {
    const original = await createSpreadsheet(
      [
        ["a", "b"],
        ["c", "d"],
      ],
      "Sheet1",
    );
    const first = await parseSpreadsheet(original);
    const edited = first.rows.map((row) => [...row]);
    edited[1]![1] = "CHANGED";
    const reserialized = await serializeSpreadsheet(original, edited);
    expect(await parseSpreadsheet(reserialized)).toMatchObject({ rows: edited });
    expect(reserialized).not.toEqual(original);
  });

  it("keeps non-first sheets untouched while the first sheet edits", async () => {
    const customers = [
      ["id", "customer"],
      ["1", "Ada"],
      ["2", "Grace"],
    ];
    const original = await createSpreadsheetWorkbook([
      { name: "Tracker", rows: [["a"]] },
      { name: "Customers", rows: customers },
    ]);
    const edited = await serializeSpreadsheet(original, [
      ["a", "b"],
      ["c", "CHANGED"],
    ]);
    const firstSheet = await parseSpreadsheet(edited);
    expect(firstSheet.sheetNames).toEqual(["Tracker", "Customers"]);
    expect(firstSheet.activeSheetName).toBe("Tracker");
    expect(firstSheet.rows).toEqual([
      ["a", "b"],
      ["c", "CHANGED"],
    ]);
    // The second sheet parses back exactly as authored.
    expect((await parseSpreadsheet(edited, 1)).rows).toEqual(customers);
  });

  it("verifies second-sheet values survive a first-sheet save", async () => {
    const customers = [
      ["id", "customer"],
      ["1", "Ada"],
    ];
    const original = await createSpreadsheetWorkbook([
      { name: "Tracker", rows: [["x"]] },
      { name: "Customers", rows: customers },
    ]);
    const before = await parseSpreadsheet(original);
    expect(before.rows).toEqual([["x"]]);
    const saved = await serializeSpreadsheet(original, [["y"]]);
    const after = await parseSpreadsheet(saved);
    expect(after.rows).toEqual([["y"]]);
    expect(after.sheetNames).toEqual(["Tracker", "Customers"]);
    // Re-saving the same grid is deterministic down to the byte.
    const resaved = await serializeSpreadsheet(saved, [["y"]]);
    const resavedAgain = await serializeSpreadsheet(saved, [["y"]]);
    expect(resaved).toEqual(resavedAgain);
  });

  it("round-trips an empty grid", async () => {
    const bytes = await createSpreadsheet([], "Empty");
    expect((await parseSpreadsheet(bytes)).rows).toEqual([]);
    const resaved = await serializeSpreadsheet(bytes, []);
    expect((await parseSpreadsheet(resaved)).rows).toEqual([]);
  });

  it("rejects files that are not workbooks", async () => {
    await expect(parseSpreadsheet(new Uint8Array([1, 2, 3]))).rejects.toThrow();
    await expect(
      parseSpreadsheet(new TextEncoder().encode("definitely not a zip")),
    ).rejects.toThrow();
  });

  describe("zip bounds", () => {
    function minimalZip(input: { method: number; flags: number }): Uint8Array {
      const name = new TextEncoder().encode("xl/workbook.xml");
      const data = new TextEncoder().encode("<workbook/>");
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, input.flags, true);
      local.setUint16(8, input.method, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      const central = new DataView(new ArrayBuffer(46));
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, input.flags, true);
      central.setUint16(10, input.method, true);
      central.setUint32(20, data.length, true);
      central.setUint32(24, data.length, true);
      central.setUint16(28, name.length, true);
      central.setUint32(42, 0, true);
      const end = new DataView(new ArrayBuffer(22));
      end.setUint32(0, 0x06054b50, true);
      end.setUint16(8, 1, true);
      end.setUint16(10, 1, true);
      end.setUint32(12, 46 + name.length, true);
      end.setUint32(16, 30 + name.length + data.length, true);
      const out = new Uint8Array(30 + name.length + data.length + 46 + name.length + 22);
      out.set(new Uint8Array(local.buffer), 0);
      out.set(name, 30);
      out.set(data, 30 + name.length);
      out.set(new Uint8Array(central.buffer), 30 + name.length + data.length);
      out.set(name, 30 + name.length + data.length + 46);
      out.set(new Uint8Array(end.buffer), 30 + name.length + data.length + 46 + name.length);
      return out;
    }

    it("rejects unsupported compression methods", async () => {
      await expect(parseSpreadsheet(minimalZip({ method: 12, flags: 0 }))).rejects.toThrow(
        /unsupported zip method/,
      );
    });

    it("rejects encrypted entries", async () => {
      await expect(parseSpreadsheet(minimalZip({ method: 0, flags: 0x0001 }))).rejects.toThrow(
        /encrypted/,
      );
    });
  });
});
