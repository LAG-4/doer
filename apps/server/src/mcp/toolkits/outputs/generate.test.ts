import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import { parseSpreadsheet } from "@t3tools/shared/spreadsheetWorkbook";
import { generateDocument, generatePresentation, generateSpreadsheet } from "./generate.ts";
describe("bundled office outputs", () => {
  it("creates an editable Word file with actual headings and escaped source text", async () => {
    const zip = await JSZip.loadAsync(
      await generateDocument({
        title: "Meeting & review",
        sections: [{ heading: "Agenda", paragraphs: ["Review <report>", "Decide next steps"] }],
      }),
    );
    const document = await zip.file("word/document.xml")!.async("string");
    expect(document).toContain("Meeting &amp; review");
    expect(document).toContain("Review &lt;report&gt;");
    expect(document).toContain("Heading1");
    expect(zip.file("[Content_Types].xml")).toBeTruthy();
  });
  it("creates distinct editable PowerPoint slides with source notes", async () => {
    const zip = await JSZip.loadAsync(
      await generatePresentation({
        title: "Monthly report",
        slides: [
          {
            title: "Overview",
            points: ["Revenue grew", "Costs stayed level"],
            notes: "Source: supplied report, September 2026",
          },
          { title: "Next steps", points: ["Review forecast"] },
        ],
      }),
    );
    expect(await zip.file("ppt/slides/slide1.xml")!.async("string")).toContain("Overview");
    expect(await zip.file("ppt/slides/slide2.xml")!.async("string")).toContain("Next steps");
    expect(await zip.file("ppt/notesSlides/notesSlide1.xml")!.async("string")).toContain(
      "September 2026",
    );
  });
  it("creates a multi-sheet Excel file that opens with the supplied numeric values", async () => {
    const bytes = await generateSpreadsheet([
      {
        name: "Summary",
        rows: [
          ["Category", "Total"],
          ["Rent", "25000"],
        ],
      },
      {
        name: "Sources",
        rows: [
          ["Source", "Date"],
          ["Supplied bills", "2026-10-01"],
        ],
      },
    ]);
    expect((await parseSpreadsheet(bytes)).rows[1]).toEqual(["Rent", "25000"]);
    expect((await parseSpreadsheet(bytes, 1)).activeSheetName).toBe("Sources");
  });
});
