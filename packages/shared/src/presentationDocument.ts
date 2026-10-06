import { escapeSpreadsheetXml, readZipEntries, writeZipEntries } from "./spreadsheetWorkbook.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function slideEntries(entries: Awaited<ReturnType<typeof readZipEntries>>) {
  return entries
    .filter((entry) => /^ppt\/slides\/slide[1-9][0-9]*\.xml$/.test(entry.name))
    .sort(
      (a, b) => Number(a.name.match(/slide(\d+)/)?.[1]) - Number(b.name.match(/slide(\d+)/)?.[1]),
    );
}

function decodeText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default: {
        const hex = entity.startsWith("&#x");
        const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
        return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
    }
  });
}

export async function inspectPresentation(
  bytes: Uint8Array,
): Promise<readonly { slide: number; text: string; runs: readonly string[] }[]> {
  const entries = await readZipEntries(bytes);
  if (!entries.some((entry) => entry.name === "ppt/presentation.xml"))
    throw new Error("Not a PowerPoint presentation.");
  return slideEntries(entries).map((entry) => {
    const runs = [...decoder.decode(entry.data).matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) =>
      decodeText(match[1] ?? ""),
    );
    return {
      slide: Number(entry.name.match(/slide(\d+)/)?.[1]),
      text: runs.join(" "),
      runs,
    };
  });
}

/** Replace an exact text run in one slide; all other package parts retain their payloads. */
export async function replacePresentationText(
  bytes: Uint8Array,
  slideNumber: number,
  oldText: string,
  newText: string,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(slideNumber) || slideNumber < 1 || !oldText || newText.length > 32767) {
    throw new Error("Choose a slide, existing text, and replacement under 32,768 characters.");
  }
  const entries = await readZipEntries(bytes);
  if (!entries.some((entry) => entry.name === "ppt/presentation.xml"))
    throw new Error("Not a PowerPoint presentation.");
  const slide = entries.find((entry) => entry.name === `ppt/slides/slide${slideNumber}.xml`);
  if (!slide) throw new Error("Slide does not exist.");
  const xml = decoder.decode(slide.data);
  const matches = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].filter(
    (match) => decodeText(match[1] ?? "") === oldText,
  );
  if (matches.length !== 1) throw new Error("Text must match exactly one run on this slide.");
  const match = matches[0];
  if (!match || match.index === undefined) throw new Error("Text was not found.");
  slide.data = encoder.encode(
    xml.slice(0, match.index) +
      `<a:t>${escapeSpreadsheetXml(newText)}</a:t>` +
      xml.slice(match.index + match[0].length),
  );
  slide.passthrough = null;
  slide.crc = 0;
  slide.method = 8;
  return writeZipEntries(entries);
}
