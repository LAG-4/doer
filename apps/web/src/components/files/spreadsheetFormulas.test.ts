import { describe, expect, it } from "vite-plus/test";

import {
  collectSpreadsheetFormulas,
  evaluateSpreadsheetFormulas,
  formatSpreadsheetComputedValue,
  isSpreadsheetFormulaCell,
  loadSpreadsheetFormulaEngine,
  type SpreadsheetFormulaEngine,
} from "./spreadsheetFormulas";

describe("spreadsheet formulas", () => {
  it("collects formula bodies from grid text", () => {
    expect(
      collectSpreadsheetFormulas([
        ["a", "=SUM(A1:A2)"],
        ["=", "= "],
      ]),
    ).toEqual([{ row: 0, col: 1, body: "SUM(A1:A2)" }]);
    expect(isSpreadsheetFormulaCell("=")).toBe(false);
    expect(isSpreadsheetFormulaCell("plain")).toBe(false);
  });

  it("formats computed values for display", () => {
    expect(formatSpreadsheetComputedValue(0.30000000000000004)).toBe("0.3");
    expect(formatSpreadsheetComputedValue(true)).toBe("TRUE");
    expect(formatSpreadsheetComputedValue("text")).toBe("text");
    expect(formatSpreadsheetComputedValue(null)).toBe("");
  });
});

describe("spreadsheet formula engine", () => {
  async function engine(): Promise<SpreadsheetFormulaEngine> {
    return loadSpreadsheetFormulaEngine();
  }

  function displays(rows: string[][], sheet = "Sheet1") {
    return { rows, formulas: collectSpreadsheetFormulas(rows), sheet };
  }

  it("evaluates SUM over a range, skipping text and blanks", async () => {
    const input = displays([
      ["Item", "Amount"],
      ["a", "10"],
      ["b", "20.5"],
      ["c", ""],
      ["TOTAL", "=SUM(B2:B4)"],
    ]);
    const out = evaluateSpreadsheetFormulas(
      input.rows,
      input.formulas,
      input.sheet,
      await engine(),
    );
    expect(out[4]?.[1]).toBe("30.5");
  });

  it("follows chained references and absolute addresses", async () => {
    const input = displays([["= $A$2 * 2"], ["21"]]);
    const out = evaluateSpreadsheetFormulas(
      input.rows,
      input.formulas,
      input.sheet,
      await engine(),
    );
    expect(out[0]?.[0]).toBe("42");
    const chained = displays([["2"], ["=A1*3"], ["=A2+1"]]);
    const chainedOut = evaluateSpreadsheetFormulas(
      chained.rows,
      chained.formulas,
      chained.sheet,
      await engine(),
    );
    expect(chainedOut[2]?.[0]).toBe("7");
  });

  it("evaluates IF, AVERAGE, and string concatenation", async () => {
    const input = displays([
      ['=IF(A2>10,"big","small")', '=AVERAGE(B2:B3)&"!"'],
      ["20", "4"],
      ["x", "6"],
    ]);
    const out = evaluateSpreadsheetFormulas(
      input.rows,
      input.formulas,
      input.sheet,
      await engine(),
    );
    expect(out[0]?.[0]).toBe("big");
    expect(out[0]?.[1]).toBe("5!");
  });

  it("marks circular references and their dependents", async () => {
    const input = displays([["=B1+1", "=A1+1"], ["=A1*2"]]);
    const out = evaluateSpreadsheetFormulas(
      input.rows,
      input.formulas,
      input.sheet,
      await engine(),
    );
    expect(out[0]?.[0]).toBe("#CYCLE!");
    expect(out[0]?.[1]).toBe("#CYCLE!");
    expect(out[1]?.[0]).toBe("#CYCLE!");
  });

  it("surfaces unparseable bodies as errors", async () => {
    const input = displays([["=SUM("], ["=NOSUCHFN(A1)"]]);
    const out = evaluateSpreadsheetFormulas(
      input.rows,
      input.formulas,
      input.sheet,
      await engine(),
    );
    // The engine reports every syntax problem (including unknown function
    // names) as #ERROR!.
    expect(out[0]?.[0]).toBe("#ERROR!");
    expect(out[1]?.[0]).toBe("#ERROR!");
  });

  it("blocks functions that reach outside the workbook", async () => {
    const input = displays([['=WEBSERVICE("https://example.com")']]);
    const out = evaluateSpreadsheetFormulas(
      input.rows,
      input.formulas,
      input.sheet,
      await engine(),
    );
    expect(out[0]?.[0]).toBe("#BLOCKED!");
  });

  it("passes the raw grid through without an engine", () => {
    const input = displays([["=SUM(A2:A3)"], ["1"]]);
    expect(evaluateSpreadsheetFormulas(input.rows, input.formulas, input.sheet, null)).toEqual(
      input.rows,
    );
  });
});
