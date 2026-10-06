import type * as Presentation from "pptxgenjs";
import { createSpreadsheetWorkbook } from "@t3tools/shared/spreadsheetWorkbook";

export interface DocumentOutput {
  readonly title: string;
  readonly sections: readonly {
    readonly heading: string;
    readonly paragraphs: readonly string[];
  }[];
}

/** Dependencies are bundled with Doer and loaded only when an output is requested. */
export async function generateDocument(input: DocumentOutput): Promise<Uint8Array> {
  const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import("docx");
  const document = new Document({
    title: input.title,
    creator: "Doer",
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22 }, paragraph: { spacing: { after: 160 } } },
      },
    },
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
          ...input.sections.flatMap((section) => [
            ...(section.heading
              ? [new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1 })]
              : []),
            ...section.paragraphs.map(
              (text) =>
                new Paragraph({
                  children: text
                    .split("\n")
                    .flatMap((line, index) => [
                      new TextRun({ text: line, ...(index ? { break: 1 } : {}) }),
                    ]),
                }),
            ),
          ]),
        ],
      },
    ],
  });
  return new Uint8Array(await Packer.toBuffer(document));
}

export async function generatePresentation(input: {
  readonly title: string;
  readonly slides: readonly {
    readonly title: string;
    readonly points: readonly string[];
    readonly notes?: string | undefined;
  }[];
}): Promise<Uint8Array> {
  const { default: PptxGenJS } = await import("pptxgenjs");
  // The package publishes ESM code with CJS-classified declarations.
  const Constructor = PptxGenJS as unknown as new () => Presentation.default;
  const presentation = new Constructor();
  presentation.layout = "LAYOUT_WIDE";
  presentation.title = input.title;
  presentation.author = "Doer";
  presentation.subject = input.title;
  presentation.theme = { headFontFace: "Arial", bodyFontFace: "Arial" };
  for (const [index, item] of input.slides.entries()) {
    const slide = presentation.addSlide();
    slide.background = { color: "FAFAF8" };
    slide.addText(item.title, {
      x: 0.7,
      y: 0.55,
      w: 11.9,
      h: 0.95,
      fontSize: 28,
      bold: true,
      color: "202A36",
      breakLine: false,
      fit: "shrink",
      margin: 0,
    });
    slide.addText(
      item.points.map((text) => ({ text, options: { bullet: { indent: 18 }, breakLine: true } })),
      {
        x: 0.85,
        y: 1.8,
        w: 11.4,
        h: 4.8,
        fontSize: 20,
        color: "303945",
        paraSpaceAfter: 16,
        valign: "top",
        fit: "shrink",
        margin: 0,
      },
    );
    slide.addText(`${index + 1}`, {
      x: 11.7,
      y: 7,
      w: 0.9,
      h: 0.2,
      fontSize: 10,
      color: "657084",
      align: "right",
      margin: 0,
    });
    if (item.notes) slide.addNotes(item.notes);
  }
  const bytes = await presentation.write({ outputType: "nodebuffer" });
  if (!(bytes instanceof Uint8Array)) throw new Error("The presentation could not be generated.");
  return bytes;
}

export const generateSpreadsheet = createSpreadsheetWorkbook;
