import { describe, expect, it } from "vite-plus/test";
import { readZipEntries, writeZipEntries, type ZipEntry } from "./spreadsheetWorkbook.ts";
import { inspectPresentation, replacePresentationText } from "./presentationDocument.ts";

const encoder = new TextEncoder();
const entry = (name: string, text: string): ZipEntry => ({
  name,
  method: 8,
  data: encoder.encode(text),
  passthrough: null,
  crc: 0,
});

describe("presentation text editing", () => {
  it("changes one exact text run while keeping other parts", async () => {
    const original = await writeZipEntries([
      entry("ppt/presentation.xml", "<p:presentation/>"),
      entry("ppt/slides/slide1.xml", "<p:sld><a:t>Hello</a:t><a:t>Keep</a:t></p:sld>"),
      entry("ppt/media/image1.png", "image bytes"),
    ]);
    expect(await inspectPresentation(original)).toEqual([{ slide: 1, text: "Hello Keep" }]);
    const edited = await replacePresentationText(original, 1, "Hello", "New & safe");
    expect(await inspectPresentation(edited)).toEqual([{ slide: 1, text: "New & safe Keep" }]);
    const before = await readZipEntries(original);
    const after = await readZipEntries(edited);
    expect(after.find((part) => part.name === "ppt/media/image1.png")?.data).toEqual(
      before.find((part) => part.name === "ppt/media/image1.png")?.data,
    );
    await expect(replacePresentationText(original, 1, "Missing", "x")).rejects.toThrow(
      /exactly one/,
    );
  });
});
