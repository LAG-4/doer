import type * as Presentation from "pptxgenjs";
import { createSpreadsheetWorkbook } from "@t3tools/shared/spreadsheetWorkbook";
import type { SpreadsheetWorkbookInput } from "@t3tools/shared/spreadsheetWorkbook";

export interface DocumentOutput {
  readonly title: string;
  readonly sections: readonly {
    readonly heading: string;
    readonly paragraphs: readonly string[];
  }[];
}

export interface PresentationOutput {
  readonly title: string;
  readonly slides: readonly {
    readonly title: string;
    readonly points: readonly string[];
    readonly notes?: string | undefined;
  }[];
}

const DOCUMENT_MAX_SECTIONS = 100;
const DOCUMENT_MAX_PARAGRAPHS_PER_SECTION = 100;
const DOCUMENT_MAX_TEXT_CHARS = 8_000;
const PRESENTATION_MAX_SLIDES = 50;
const PRESENTATION_MAX_POINTS = 8;
const PRESENTATION_MAX_TITLE_CHARS = 120;
const PRESENTATION_MAX_POINT_CHARS = 500;
/**
 * Visible text budget per slide (title plus bullets). The template shrinks
 * text to fit a fixed box, so without this cap a full 8×500 slide would
 * render microscopically small. This only blocks obvious overflow — it does
 * not certify rendered quality, which the user should check in their office
 * app. Speaker notes are excluded: they never render on the slide.
 */
const PRESENTATION_MAX_VISIBLE_CHARS_PER_SLIDE = 1_200;
const SPREADSHEET_MAX_SHEETS = 20;
const SPREADSHEET_MAX_ROWS = 2_000;
const SPREADSHEET_MAX_COLS = 100;
const SPREADSHEET_MAX_CELLS = 100_000;

function assertReadableTitle(title: string, kind: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new Error(`Add a short ${kind} title with actual words before saving.`);
  }
  if (trimmed.length > 200) {
    throw new Error(`Shorten the ${kind} title to 200 characters or fewer so it stays readable.`);
  }
  return trimmed;
}

/** Rejects blank-only documents before they are reported as success. */
export function validateDocumentInput(input: DocumentOutput): void {
  assertReadableTitle(input.title, "document");
  if (input.sections.length < 1 || input.sections.length > DOCUMENT_MAX_SECTIONS) {
    throw new Error(`Add 1 to ${DOCUMENT_MAX_SECTIONS} sections with real content before saving.`);
  }
  let hasContent = false;
  for (const section of input.sections) {
    if (section.heading.trim().length > 0) hasContent = true;
    if (section.paragraphs.length > DOCUMENT_MAX_PARAGRAPHS_PER_SECTION) {
      throw new Error(
        `Keep each section to ${DOCUMENT_MAX_PARAGRAPHS_PER_SECTION} paragraphs or fewer so the document stays readable.`,
      );
    }
    for (const paragraph of section.paragraphs) {
      if (paragraph.length > DOCUMENT_MAX_TEXT_CHARS) {
        throw new Error("Shorten paragraphs over 8,000 characters or split them before saving.");
      }
      if (paragraph.trim().length > 0) hasContent = true;
    }
    if (section.heading.length > 200) {
      throw new Error("Keep section headings to 200 characters or fewer.");
    }
  }
  if (!hasContent) {
    throw new Error(
      "Add at least one heading or paragraph with actual words; blank-only documents cannot be saved.",
    );
  }
}

/** Rejects blank-only or overflow presentations before success is reported. */
export function validatePresentationInput(input: PresentationOutput): void {
  assertReadableTitle(input.title, "presentation");
  if (input.slides.length < 1 || input.slides.length > PRESENTATION_MAX_SLIDES) {
    throw new Error(`Add 1 to ${PRESENTATION_MAX_SLIDES} slides with real content before saving.`);
  }
  // Explicit policy: title-only slides are allowed (e.g. section dividers),
  // but a deck needs at least one slide with a real bullet or note — a deck
  // of bare titles is reported as a failure, not a success.
  let hasBody = false;
  for (const slide of input.slides) {
    const title = slide.title.trim();
    if (title.length < 1 || title.length > PRESENTATION_MAX_TITLE_CHARS) {
      throw new Error(
        `Give every slide a short title (1 to ${PRESENTATION_MAX_TITLE_CHARS} characters) before saving.`,
      );
    }
    if (slide.points.length > PRESENTATION_MAX_POINTS) {
      throw new Error(
        `Keep each slide to ${PRESENTATION_MAX_POINTS} bullet points or fewer so the text fits on the slide.`,
      );
    }
    let visible = title.length;
    for (const point of slide.points) {
      if (point.length > PRESENTATION_MAX_POINT_CHARS) {
        throw new Error(
          `Shorten bullet points over ${PRESENTATION_MAX_POINT_CHARS} characters before saving.`,
        );
      }
      visible += point.length;
      if (point.trim().length > 0) hasBody = true;
    }
    if (slide.notes !== undefined && slide.notes.length > DOCUMENT_MAX_TEXT_CHARS) {
      throw new Error("Shorten speaker notes over 8,000 characters before saving.");
    }
    if (slide.notes !== undefined && slide.notes.trim().length > 0) hasBody = true;
    if (visible > PRESENTATION_MAX_VISIBLE_CHARS_PER_SLIDE) {
      throw new Error(
        `Keep each slide to about ${PRESENTATION_MAX_VISIBLE_CHARS_PER_SLIDE.toLocaleString()} characters of title and bullets so the text fits; split crowded slides before saving.`,
      );
    }
  }
  if (!hasBody) {
    throw new Error(
      "Add at least one bullet point or note with actual words; a deck of titles alone cannot be saved.",
    );
  }
}

/**
 * Rejects blank-only or overflow workbooks. Cells stay plain strings by
 * design (numbers and dates travel as text; formula-like text is stored as
 * text for safety) — this validation only guards readability, never
 * arithmetic.
 */
export function validateSpreadsheetInput(sheets: readonly SpreadsheetWorkbookInput[]): void {
  if (sheets.length < 1 || sheets.length > SPREADSHEET_MAX_SHEETS) {
    throw new Error(`Add 1 to ${SPREADSHEET_MAX_SHEETS} sheets with real content before saving.`);
  }
  let totalCells = 0;
  let hasContent = false;
  for (const sheet of sheets) {
    const name = sheet.name.trim();
    if (name.length < 1 || name.length > 31) {
      throw new Error("Give every sheet a short name (1 to 31 characters) before saving.");
    }
    if (sheet.rows.length > SPREADSHEET_MAX_ROWS) {
      throw new Error(
        `Keep each sheet to ${SPREADSHEET_MAX_ROWS} rows or fewer so the file stays readable.`,
      );
    }
    for (const row of sheet.rows) {
      if (row.length > SPREADSHEET_MAX_COLS) {
        throw new Error(
          `Keep each row to ${SPREADSHEET_MAX_COLS} columns or fewer so the file stays readable.`,
        );
      }
      totalCells += row.length;
      for (const cell of row) {
        if (cell.length > 1000) {
          throw new Error("Shorten cells over 1,000 characters before saving.");
        }
        if (cell.trim().length > 0) hasContent = true;
      }
    }
  }
  if (totalCells > SPREADSHEET_MAX_CELLS) {
    throw new Error(
      "This workbook has too many cells to stay readable. Split it into smaller sheets before saving.",
    );
  }
  if (!hasContent) {
    throw new Error(
      "Add at least one cell with actual words or numbers; blank-only spreadsheets cannot be saved.",
    );
  }
}

/** Dependencies are bundled with Doer and loaded only when an output is requested. */
export async function generateDocument(input: DocumentOutput): Promise<Uint8Array> {
  validateDocumentInput(input);
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

export async function generatePresentation(input: PresentationOutput): Promise<Uint8Array> {
  validatePresentationInput(input);
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

export async function generateSpreadsheet(
  sheets: readonly SpreadsheetWorkbookInput[],
): Promise<Uint8Array> {
  validateSpreadsheetInput(sheets);
  return createSpreadsheetWorkbook(sheets);
}
