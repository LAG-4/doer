import JSZip from "jszip";
import { describe, expect, it } from "vite-plus/test";
import { parseSpreadsheet } from "@t3tools/shared/spreadsheetWorkbook";
import {
  generateDocument,
  generatePresentation,
  generateSpreadsheet,
  validatePresentationInput,
} from "./generate.ts";
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
  it("rejects blank-only outputs instead of reporting success", async () => {
    await expect(
      generateDocument({ title: "Empty", sections: [{ heading: "  ", paragraphs: ["   "] }] }),
    ).rejects.toThrow(/actual words/);
    await expect(
      generateSpreadsheet([
        {
          name: "Sheet1",
          rows: [
            ["  ", ""],
            ["", " "],
          ],
        },
      ]),
    ).rejects.toThrow(/actual words or numbers/);
    await expect(
      generatePresentation({ title: "Deck", slides: [{ title: "Only a title", points: [] }] }),
    ).rejects.toThrow(/titles alone/);
  });
  it("rejects overflow instead of producing unreadable files", async () => {
    await expect(
      generateDocument({
        title: "Big",
        sections: [{ heading: "S", paragraphs: ["x".repeat(8_001)] }],
      }),
    ).rejects.toThrow(/8,000/);
    await expect(
      generatePresentation({
        title: "Deck",
        slides: [{ title: "Crowded", points: Array.from({ length: 8 }, () => "y".repeat(200)) }],
      }),
    ).rejects.toThrow(/split crowded slides/);
  });
  it("bounds slide titles and allows title-only slides beside real content", () => {
    expect(() =>
      validatePresentationInput({
        title: "Deck",
        slides: [{ title: "z".repeat(121), points: ["Real point"] }],
      }),
    ).toThrow(/1 to 120/);
    expect(() =>
      validatePresentationInput({
        title: "Deck",
        slides: [
          { title: "Section", points: [] },
          { title: "Detail", points: ["Real point"], notes: "Source: supplied notes" },
        ],
      }),
    ).not.toThrow();
  });
});
