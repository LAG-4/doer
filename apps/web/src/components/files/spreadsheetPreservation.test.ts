import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import {
  createSpreadsheetWorkbook,
  parseSpreadsheet,
  serializeSpreadsheet,
} from "@t3tools/shared/spreadsheetWorkbook";
import {
  collectSpreadsheetFormulas,
  evaluateSpreadsheetFormulas,
  loadSpreadsheetFormulaEngine,
} from "./spreadsheetFormulas";

describe("imported spreadsheet preservation", () => {
  it("changes a selected sheet's values while preserving styles, sizing, filters, other sheets and formulas", async () => {
    const zip = await JSZip.loadAsync(
      await createSpreadsheetWorkbook([
        { name: "Original", rows: [["Keep", "42"]] },
        {
          name: "Report",
          rows: [
            ["Name", "Amount"],
            ["Rent", "100"],
            ["Total", "=B2"],
          ],
        },
      ]),
    );
    const original = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const report = (await zip.file("xl/worksheets/sheet2.xml")!.async("string"))
      .replace(
        '<c r="B3" t="inlineStr"><is><t>=B2</t></is></c>',
        '<c r="B3"><f>B2</f><v>100</v></c>',
      )
      .replace(
        "<sheetData>",
        '<cols><col min="1" max="1" width="30" customWidth="1"/></cols><sheetData>',
      )
      .replace('<row r="2">', '<row r="2" ht="25" customHeight="1">')
      .replace('<c r="B2"', '<c r="B2" s="1"')
      .replace("</worksheet>", '<autoFilter ref="A1:B3"/></worksheet>');
    zip.file("xl/worksheets/sheet2.xml", report);
    const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const parsed = await parseSpreadsheet(bytes, 1);
    const rows = parsed.rows.map((row) => [...row]);
    rows[1]![1] = "120";
    const saved = await serializeSpreadsheet(bytes, rows, undefined, 1);
    const result = await JSZip.loadAsync(saved);
    const changed = await result.file("xl/worksheets/sheet2.xml")!.async("string");
    expect(await result.file("xl/worksheets/sheet1.xml")!.async("string")).toBe(original);
    expect(changed).toContain('s="1"');
    expect(changed).toContain('ht="25" customHeight="1"');
    expect(changed).toContain('<autoFilter ref="A1:B3"/>');
    expect(changed).toContain('width="30"');
    expect(changed).toContain("<f>B2</f>");
    expect((await parseSpreadsheet(saved, 1)).rows[1]?.[1]).toBe("120");
  });
  it("uses saved results for cross-sheet formulas and refuses to destroy merged/protected layouts", async () => {
    const zip = await JSZip.loadAsync(
      await createSpreadsheetWorkbook([
        { name: "Totals", rows: [["=Other!A1"]] },
        { name: "Other", rows: [["73"]] },
      ]),
    );
    let xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    xml = xml.replace(
      '<c r="A1" t="inlineStr"><is><t>=Other!A1</t></is></c>',
      '<c r="A1"><f>Other!A1</f><v>73</v></c>',
    );
    zip.file("xl/worksheets/sheet1.xml", xml);
    let bytes = await zip.generateAsync({ type: "uint8array" });
    const parsed = await parseSpreadsheet(bytes);
    const values = evaluateSpreadsheetFormulas(
      parsed.rows,
      collectSpreadsheetFormulas(parsed.rows),
      "Totals",
      await loadSpreadsheetFormulaEngine(),
      { rows: parsed.rows, cachedRows: parsed.cachedRows },
    );
    expect(values[0]?.[0]).toBe("73");
    zip.file(
      "xl/worksheets/sheet1.xml",
      xml.replace(
        "</worksheet>",
        '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>',
      ),
    );
    bytes = await zip.generateAsync({ type: "uint8array" });
    expect((await parseSpreadsheet(bytes)).editingBlockedReason).toBeTruthy();
    await expect(serializeSpreadsheet(bytes, [["Changed"]])).rejects.toThrow(/advanced formatting/);
  });
});
