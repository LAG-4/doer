// @effect-diagnostics globalDate:off -- Excel serials decompose to UTC calendar days/times via Date.
/**
 * spreadsheetWorkbook - dependency-light .xlsx read/write for the browser,
 * Node, and Bun runtimes.
 *
 * Approach (not code) follows OpenWork's MIT `packages/workbook` design:
 * plain string-cell grid model, ragged rows normalized to a rectangle,
 * serialize-on-save round trips. Unlike a full spreadsheet library there is
 * no formula engine, no styling, and no chart support: every cell is a
 * string, numbers and dates travel as plain text, and only the first sheet
 * is editable. All other sheets are preserved untouched on save.
 *
 * Zero dependencies: zip (stored + deflate) and the minimal OOXML parts are
 * implemented here on top of the platform's CompressionStream /
 * DecompressionStream, which also lets the UI feature-detect support and
 * show a fallback where the APIs are missing.
 *
 * @module spreadsheetWorkbook
 */

export interface SpreadsheetSheetGrid {
  readonly name: string;
  readonly rows: string[][];
}

export interface ParsedSpreadsheet {
  readonly sheetNames: string[];
  readonly activeSheetName: string;
  readonly rows: string[][];
}

export interface SpreadsheetWorkbookInput {
  readonly name: string;
  readonly rows: readonly (readonly string[])[];
}

const SPREADSHEETML_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_DOCUMENT_REL = `${PACKAGE_REL_NS}/officeDocument`;

/**
 * Defensive bounds, mirroring OpenWork's bounded OOXML package policy: every
 * limit protects the host process (browser tab, server) from hostile
 * workbooks. The server already caps reads at 1 MB; these guards cover
 * attachments and future larger caps.
 */
const ZIP_MAX_COMPRESSED_BYTES = 12 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 128;
const ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES = 2 * 1024 * 1024;
const ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
const ZIP_MAX_COMPRESSION_RATIO = 100;
const ZIP_FLAG_ENCRYPTED = 0x0001;
const ZIP_FLAG_DATA_DESCRIPTOR = 0x0008;
const ZIP_FLAG_STRONG_ENCRYPTION = 0x0040;

/** True when this runtime can inflate/deflate workbook zips. */
export function isSpreadsheetRuntimeSupported(): boolean {
  const scope = globalThis as Record<string, unknown>;
  return (
    typeof scope["CompressionStream"] === "function" &&
    typeof scope["DecompressionStream"] === "function" &&
    typeof scope["TextEncoder"] === "function" &&
    typeof scope["TextDecoder"] === "function"
  );
}

function textEncoder(): { encode(input: string): Uint8Array } {
  const scope = globalThis as Record<string, unknown>;
  const Ctor = scope["TextEncoder"] as new () => { encode(input: string): Uint8Array };
  return new Ctor();
}

function textDecoder(): { decode(input: Uint8Array): string } {
  const scope = globalThis as Record<string, unknown>;
  const Ctor = scope["TextDecoder"] as new () => { decode(input: Uint8Array): string };
  return new Ctor();
}

function compressionStream(
  format: "deflate-raw",
  mode: "compress" | "decompress",
): {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
} {
  const scope = globalThis as Record<string, unknown>;
  const name = mode === "compress" ? "CompressionStream" : "DecompressionStream";
  const Ctor = scope[name] as new (format: string) => {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
  };
  return new Ctor(format);
}

async function streamThrough(
  input: Uint8Array,
  mode: "compress" | "decompress",
  outputLimit: number,
  label: string,
): Promise<Uint8Array> {
  if (input.length === 0) return new Uint8Array(0);
  const stream = compressionStream("deflate-raw", mode);
  // Copy into a plain ArrayBuffer-backed view: callers may pass Node Buffers
  // or views over shared memory, which the streams API does not accept.
  const chunk = new Uint8Array(input.byteLength);
  chunk.set(input);
  // The reader must pump concurrently with the writer: waiting for close()
  // before reading deadlocks once output exceeds the internal buffer.
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let limitError: Error | null = null;
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > outputLimit) {
          limitError = new Error(`Spreadsheet zip entry ${label} exceeds its size limit.`);
          await reader.cancel(limitError).catch(() => undefined);
          break;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  })();
  const writer = stream.writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    await writer.close().catch(() => undefined);
    writer.releaseLock();
  }
  await pump;
  if (limitError) throw limitError;
  const output = new Uint8Array(total);
  let offset = 0;
  for (const piece of chunks) {
    output.set(piece, offset);
    offset += piece.byteLength;
  }
  return output;
}

function inflateRaw(data: Uint8Array, limit: number, label: string): Promise<Uint8Array> {
  return streamThrough(data, "decompress", limit, label);
}

function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return streamThrough(data, "compress", ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES + 1024, "(deflate)");
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Char(index: number): string {
  return BASE64_ALPHABET[index & 63] ?? "";
}

/** Portable bytes-to-base64 for the file RPC payloads. */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const triple =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    output +=
      base64Char(triple >>> 18) +
      base64Char(triple >>> 12) +
      base64Char(triple >>> 6) +
      base64Char(triple);
  }
  const remaining = bytes.length - index;
  if (remaining === 1) {
    const single = (bytes[index] ?? 0) << 16;
    output += base64Char(single >>> 18) + base64Char(single >>> 12) + "==";
  } else if (remaining === 2) {
    const pair = ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8);
    output += base64Char(pair >>> 18) + base64Char(pair >>> 12) + base64Char(pair >>> 6) + "=";
  }
  return output;
}

/** Portable base64-to-bytes. Throws on malformed input. */
export function base64ToBytes(base64: string): Uint8Array {
  const compact = base64.replace(/\s/g, "");
  if (compact.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(compact)) {
    throw new Error("Invalid base64 spreadsheet payload.");
  }
  const lookup = new Map<string, number>();
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    lookup.set(BASE64_ALPHABET[index] ?? "", index);
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((compact.length / 4) * 3 - padding);
  let outIndex = 0;
  for (let index = 0; index < compact.length; index += 4) {
    const sextets = [
      compact[index],
      compact[index + 1],
      compact[index + 2],
      compact[index + 3],
    ].map((char) => (char === "=" ? 0 : (lookup.get(char ?? "") ?? 0)));
    const triple =
      ((sextets[0] ?? 0) << 18) |
      ((sextets[1] ?? 0) << 12) |
      ((sextets[2] ?? 0) << 6) |
      (sextets[3] ?? 0);
    if (outIndex < output.length) output[outIndex++] = (triple >>> 16) & 255;
    if (outIndex < output.length) output[outIndex++] = (triple >>> 8) & 255;
    if (outIndex < output.length) output[outIndex++] = triple & 255;
  }
  return output;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let entry = value;
    for (let bit = 0; bit < 8; bit += 1) {
      entry = entry & 1 ? 0xedb88320 ^ (entry >>> 1) : entry >>> 1;
    }
    table[value] = entry >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index += 1) {
    crc = (CRC_TABLE[(crc ^ (data[index] ?? 0)) & 255] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Strip characters that are illegal in XML 1.0 (keeping tab, LF, CR). */
function stripIllegalXmlChars(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0x20;
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) out += char;
  }
  return out;
}

export function escapeSpreadsheetXml(value: string): string {
  return stripIllegalXmlChars(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function unescapeSpreadsheetXml(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_match, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, digits: string) =>
      String.fromCodePoint(Number.parseInt(digits, 16)),
    )
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function columnIndexToLetters(index: number): string {
  let letters = "";
  let value = index;
  do {
    letters = String.fromCharCode(65 + (value % 26)) + letters;
    value = Math.floor(value / 26) - 1;
  } while (value >= 0);
  return letters;
}

export function cellRefToIndexes(ref: string): { row: number; col: number } | null {
  const match = /^([A-Za-z]+)(\d+)$/.exec(ref.trim());
  if (!match) return null;
  const letters = (match[1] ?? "").toUpperCase();
  let col = 0;
  for (const char of letters) {
    col = col * 26 + (char.charCodeAt(0) - 64);
  }
  return { row: Number(match[2]) - 1, col: col - 1 };
}

/** Match a tag with or without a namespace prefix (`c` or `x:c`). */
function tagPattern(name: string): string {
  return `(?:[A-Za-z_][\\w.-]*:)?${name}`;
}

function attributeValue(tag: string, name: string): string | null {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const match = pattern.exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

/** Reject DTD/entity declarations: hostile workbooks must not reach the parser. */
function assertSafeSpreadsheetXml(xml: string): void {
  const lower = xml.toLowerCase();
  if (lower.includes("<!doctype") || lower.includes("<!entity")) {
    throw new Error("Not a spreadsheet file (XML declarations unsupported).");
  }
}

function normalizedZipPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments.join("/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

/** Relationship targets, skipping external and absolute references. */
function relationshipTargets(xml: string | null, basePath: string): Map<string, string> {
  const targets = new Map<string, string>();
  if (!xml) return targets;
  const pattern = new RegExp(`<${tagPattern("Relationship")}\\b([^>]*?)\\/>`, "g");
  let match = pattern.exec(xml);
  while (match) {
    const tag = match[1] ?? "";
    const id = attributeValue(tag, "Id");
    const target = attributeValue(tag, "Target");
    const mode = attributeValue(tag, "TargetMode");
    if (!id || !target || mode === "External" || /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      match = pattern.exec(xml);
      continue;
    }
    targets.set(
      id,
      target.startsWith("/")
        ? normalizedZipPath(target.slice(1))
        : normalizedZipPath(basePath, target),
    );
    match = pattern.exec(xml);
  }
  return targets;
}

/** Pad ragged rows with "" so the grid is a rectangle. */
export function normalizeSpreadsheetGrid(
  rows: readonly (readonly (string | null | undefined)[] | null | undefined)[] | null | undefined,
): string[][] {
  if (!rows) return [];
  const normalized = rows.map((row) => (row ?? []).map((cell) => cell ?? ""));
  const width = normalized.reduce((max, row) => Math.max(max, row.length), 0);
  return normalized.map((row) =>
    row.length < width
      ? [...row, ...Array.from({ length: width - row.length }, () => "")]
      : [...row],
  );
}

export function spreadsheetGridsEqual(
  a: readonly (readonly string[])[],
  b: readonly (readonly string[])[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((row, rowIndex) => {
    const other = b[rowIndex] ?? [];
    return row.length === other.length && row.every((cell, colIndex) => cell === other[colIndex]);
  });
}

function collectTextRuns(inner: string): string {
  const runs: string[] = [];
  const pattern = new RegExp(
    `<${tagPattern("t")}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern("t")}>`,
    "g",
  );
  let match = pattern.exec(inner);
  if (!match) return unescapeSpreadsheetXml(inner.replace(/<[^>]*>/g, ""));
  while (match) {
    runs.push(unescapeSpreadsheetXml(match[1] ?? ""));
    match = pattern.exec(inner);
  }
  return runs.join("");
}

function parseSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  assertSafeSpreadsheetXml(xml);
  const pattern = new RegExp(
    `<${tagPattern("si")}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern("si")}>`,
    "g",
  );
  let match = pattern.exec(xml);
  while (match) {
    strings.push(collectTextRuns(match[1] ?? ""));
    match = pattern.exec(xml);
  }
  return strings;
}

function parseCellValue(
  cellTag: string,
  cellInner: string | null,
  sharedStrings: readonly string[],
  numberFormat?: string,
  date1904 = false,
): string {
  const type = attributeValue(cellTag, "t") ?? "";
  const valuePattern = new RegExp(
    `<${tagPattern("v")}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern("v")}>`,
  );
  const formulaPattern = new RegExp(
    `<${tagPattern("f")}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern("f")}>`,
  );
  if (type === "inlineStr") {
    const isPattern = new RegExp(
      `<${tagPattern("is")}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern("is")}>`,
    );
    const isMatch = isPattern.exec(cellInner ?? "");
    return isMatch ? collectTextRuns(isMatch[1] ?? "") : "";
  }
  // Formula cells keep their body text (`=SUM(A1:A2)`), never the cached
  // result: the grid owns formulas as text and the UI computes display
  // values live, so formulas survive unlimited save round-trips.
  const formulaMatch = formulaPattern.exec(cellInner ?? "");
  if (formulaMatch) return `=${unescapeSpreadsheetXml(formulaMatch[1] ?? "")}`;
  if (type === "s") {
    const valueMatch = valuePattern.exec(cellInner ?? "");
    if (!valueMatch) return "";
    const index = Number((valueMatch[1] ?? "").trim());
    return sharedStrings[index] ?? "";
  }
  // Booleans read as the TRUE/FALSE text Excel shows.
  if (type === "b") {
    const valueMatch = valuePattern.exec(cellInner ?? "");
    return (valueMatch?.[1] ?? "").trim() === "1" ? "TRUE" : "FALSE";
  }
  const valueMatch = valuePattern.exec(cellInner ?? "");
  if (valueMatch) {
    const raw = unescapeSpreadsheetXml(valueMatch[1] ?? "");
    // Date-formatted serials read as ISO dates; plain numbers read
    // General-formatted; cached formula results and errors travel as text.
    if ((type === "" || type === "n") && isDateNumberFormat(numberFormat)) {
      return excelSerialToIso(Number(raw), date1904) ?? raw;
    }
    if (type === "" || type === "n") return formatSpreadsheetNumber(raw);
    return raw;
  }
  return "";
}

function builtinNumberFormat(id: string): string {
  switch (id) {
    case "0":
      return "General";
    case "1":
      return "0";
    case "2":
      return "0.00";
    case "9":
      return "0%";
    case "10":
      return "0.00%";
    case "14":
      return "mm-dd-yy";
    case "20":
      return "h:mm";
    case "21":
      return "h:mm:ss";
    case "22":
      return "m/d/yy h:mm";
    case "27":
    case "28":
    case "29":
    case "30":
    case "31":
    case "36":
    case "50":
      return "yyyy-mm-dd";
    case "45":
      return "mm:ss";
    case "49":
      return "@";
    default:
      return "";
  }
}

function parseNumberFormats(stylesXml: string | null): string[] {
  if (!stylesXml) return [];
  assertSafeSpreadsheetXml(stylesXml);
  const custom = new Map<string, string>();
  const numFmtPattern = new RegExp(`<${tagPattern("numFmt")}\\b([^>]*?)\\/>`, "g");
  let numFmtMatch = numFmtPattern.exec(stylesXml);
  while (numFmtMatch) {
    const tag = numFmtMatch[1] ?? "";
    const id = attributeValue(tag, "numFmtId");
    const code = attributeValue(tag, "formatCode");
    if (id && code) custom.set(id, code);
    numFmtMatch = numFmtPattern.exec(stylesXml);
  }
  const cellXfsPattern = new RegExp(
    `<${tagPattern("cellXfs")}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern("cellXfs")}>`,
  );
  const cellXfs = cellXfsPattern.exec(stylesXml)?.[1] ?? "";
  const xfPattern = new RegExp(`<${tagPattern("xf")}\\b([^>]*?)\\/\\s*>`, "g");
  const formats: string[] = [];
  let xfMatch = xfPattern.exec(cellXfs);
  while (xfMatch) {
    const id = attributeValue(xfMatch[1] ?? "", "numFmtId") ?? "0";
    formats.push(custom.get(id) ?? builtinNumberFormat(id));
    xfMatch = xfPattern.exec(cellXfs);
  }
  return formats;
}

export function isDateNumberFormat(format: string | undefined): boolean {
  if (!format || format === "General" || format === "@") return false;
  const stripped = format
    .replace(/"[^"]*"/g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/\\./g, "")
    .replace(/[Ee][+-]/g, "");
  return /[ymdhs]/i.test(stripped);
}

const EXCEL_EPOCH_1900_MS = Date.UTC(1899, 11, 30);
const EXCEL_EPOCH_1904_MS = Date.UTC(1904, 0, 1);
const MS_PER_DAY = 86_400_000;

export function excelSerialToIso(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial > 2_958_465) return null;
  // The 1900 system counts a phantom 1900-02-29, so serials before that day
  // sit one day later than the post-leap epoch implies.
  const epoch = date1904
    ? EXCEL_EPOCH_1904_MS
    : serial < 60
      ? EXCEL_EPOCH_1900_MS + MS_PER_DAY
      : EXCEL_EPOCH_1900_MS;
  const ms = Math.round(serial * MS_PER_DAY);
  const date = new Date(epoch + ms);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (value: number): string => String(value).padStart(2, "0");
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  if (serial < 1 && !date1904) return time;
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (ms % MS_PER_DAY === 0) return day;
  return `${day} ${time}`;
}

function parseDate1904(workbookXml: string): boolean {
  const pattern = new RegExp(`<${tagPattern("workbookPr")}\\b([^>]*?)\\/\\s*>`, "g");
  let match = pattern.exec(workbookXml);
  while (match) {
    const flag = attributeValue(match[1] ?? "", "date1904");
    if (flag === "1" || flag === "true") return true;
    match = pattern.exec(workbookXml);
  }
  return false;
}

/** Parse one worksheet part into a normalized string grid. */
export function parseSheetGrid(
  xml: string,
  sharedStrings: readonly string[] = [],
  options: { numberFormats?: readonly string[]; date1904?: boolean } = {},
): string[][] {
  const cells = new Map<number, Map<number, string>>();
  let maxRow = -1;
  let maxCol = -1;
  let sequentialRow = 0;
  const rowPattern = new RegExp(
    `<${tagPattern("row")}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tagPattern("row")}>)`,
    "g",
  );
  let rowMatch = rowPattern.exec(xml);
  if (!rowMatch) return [];
  while (rowMatch) {
    const rowTag = rowMatch[1] ?? "";
    const rowInner = rowMatch[2] ?? null;
    const rowAttr = attributeValue(rowTag, "r");
    const rowIndex = rowAttr ? Number(rowAttr) - 1 : sequentialRow;
    sequentialRow = (Number.isFinite(rowIndex) ? rowIndex : sequentialRow) + 1;
    if (!Number.isFinite(rowIndex) || rowIndex < 0) {
      rowMatch = rowPattern.exec(xml);
      continue;
    }
    let sequentialCol = 0;
    const cellPattern = new RegExp(
      `<${tagPattern("c")}\\b([^>]*?)(?:\\/>|>([\\s\\S]*?)<\\/${tagPattern("c")}>)`,
      "g",
    );
    let cellMatch = cellPattern.exec(rowInner ?? "");
    while (cellMatch) {
      const cellTag = cellMatch[1] ?? "";
      const cellInner = cellMatch[2] ?? null;
      const ref = attributeValue(cellTag, "r");
      const parsed = ref ? cellRefToIndexes(ref) : null;
      const colIndex =
        parsed &&
        Number.isFinite(parsed.col) &&
        parsed.col >= 0 &&
        (!Number.isFinite(parsed.row) || parsed.row === rowIndex)
          ? parsed.col
          : sequentialCol;
      sequentialCol = colIndex + 1;
      const styleIndex = attributeValue(cellTag, "s");
      const numberFormat =
        styleIndex === null ? undefined : options.numberFormats?.[Number(styleIndex)];
      const value = parseCellValue(
        cellTag,
        cellInner,
        sharedStrings,
        numberFormat,
        options.date1904,
      );
      let rowMap = cells.get(rowIndex);
      if (!rowMap) {
        rowMap = new Map<number, string>();
        cells.set(rowIndex, rowMap);
      }
      rowMap.set(colIndex, value);
      maxRow = Math.max(maxRow, rowIndex);
      maxCol = Math.max(maxCol, colIndex);
      cellMatch = cellPattern.exec(rowInner ?? "");
    }
    rowMatch = rowPattern.exec(xml);
  }
  if (maxRow < 0 || maxCol < 0) return [];
  const grid: string[][] = [];
  for (let row = 0; row <= maxRow; row += 1) {
    const rowMap = cells.get(row);
    const out: string[] = [];
    for (let col = 0; col <= maxCol; col += 1) {
      out.push(rowMap?.get(col) ?? "");
    }
    grid.push(out);
  }
  return grid;
}

function parseSheetTargets(
  workbookXml: string,
  workbookRelsXml: string,
): { name: string; entry: string }[] {
  assertSafeSpreadsheetXml(workbookXml);
  const targetsById = relationshipTargets(workbookRelsXml || null, "xl");
  const sheets: { name: string; entry: string }[] = [];
  const sheetPattern = new RegExp(`<${tagPattern("sheet")}\\b([^>]*?)\\/>`, "g");
  let sheetMatch = sheetPattern.exec(workbookXml);
  while (sheetMatch) {
    const tag = sheetMatch[1] ?? "";
    const name = attributeValue(tag, "name") ?? `Sheet${sheets.length + 1}`;
    const refId = attributeValue(tag, "r:id") ?? attributeValue(tag, "id") ?? "";
    const entry = targetsById.get(refId);
    if (entry) {
      sheets.push({ name: unescapeSpreadsheetXml(name), entry });
    } else if (!refId) {
      // Writers that omit relationship ids keep worksheets in file order.
      sheets.push({
        name: unescapeSpreadsheetXml(name),
        entry: `xl/worksheets/sheet${sheets.length + 1}.xml`,
      });
    }
    sheetMatch = sheetPattern.exec(workbookXml);
  }
  return sheets;
}

interface ZipEntry {
  name: string;
  method: 0 | 8;
  /** Decompressed payload. */
  data: Uint8Array;
  /** Original compressed payload bytes, reused verbatim for untouched entries. */
  passthrough: Uint8Array | null;
  crc: number;
}

function readDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

async function readZipEntries(bytes: Uint8Array): Promise<ZipEntry[]> {
  if (bytes.byteLength > ZIP_MAX_COMPRESSED_BYTES) {
    throw new Error("Not a spreadsheet file (zip exceeds size limit).");
  }
  const view = readDataView(bytes);
  // The end record must sit exactly at the end (comment length included) so
  // a zip signature inside file data cannot pass as the directory.
  let eocdOffset = -1;
  const scanStart = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= scanStart; offset -= 1) {
    if (offset < 0 || view.getUint32(offset, true) !== 0x06054b50) continue;
    if (offset + 22 + view.getUint16(offset + 20, true) === bytes.length) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Not a spreadsheet file (zip directory missing).");
  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const countOnDisk = view.getUint16(eocdOffset + 8, true);
  const entryCount = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || countOnDisk !== entryCount) {
    throw new Error("Not a spreadsheet file (multi-disk zips unsupported).");
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("Not a spreadsheet file (zip64 unsupported).");
  }
  if (entryCount > ZIP_MAX_ENTRIES) {
    throw new Error("Not a spreadsheet file (too many zip entries).");
  }
  if (centralOffset + centralSize > bytes.length) {
    throw new Error("Not a spreadsheet file (zip directory corrupt).");
  }
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > eocdOffset) {
    throw new Error("Not a spreadsheet file (zip directory corrupt).");
  }
  const decoder = textDecoder();
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralEnd || view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("Not a spreadsheet file (zip directory corrupt).");
    }
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true) >>> 0;
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    ) {
      throw new Error("Not a spreadsheet file (zip64 unsupported).");
    }
    if (cursor + 46 + nameLength + extraLength + commentLength > centralEnd) {
      throw new Error("Not a spreadsheet file (zip directory corrupt).");
    }
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & ZIP_FLAG_ENCRYPTED) !== 0 || (flags & ZIP_FLAG_STRONG_ENCRYPTION) !== 0) {
      throw new Error(`Not a spreadsheet file (encrypted entry ${name}).`);
    }
    if (method !== 0 && method !== 8) {
      throw new Error(`Not a spreadsheet file (unsupported zip method ${method}).`);
    }
    if (uncompressedSize > ZIP_MAX_ENTRY_UNCOMPRESSED_BYTES) {
      throw new Error(`Not a spreadsheet file (entry ${name} too large).`);
    }
    if (uncompressedSize > 0 && compressedSize === 0) {
      throw new Error(`Not a spreadsheet file (entry ${name} corrupt).`);
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > ZIP_MAX_COMPRESSION_RATIO) {
      throw new Error(`Not a spreadsheet file (entry ${name} exceeds compression ratio).`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > ZIP_MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw new Error("Not a spreadsheet file (zip exceeds total size limit).");
    }
    // The validated central directory is authoritative. Streaming writers
    // leave local-header sizes at zero behind a data-descriptor flag; the
    // local entry must either repeat the central sizes or omit them.
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
      throw new Error("Not a spreadsheet file (zip entry corrupt).");
    }
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCompressedSize = view.getUint32(localOffset + 18, true);
    const localUncompressedSize = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    if (
      (localFlags & ZIP_FLAG_ENCRYPTED) !== 0 ||
      (localFlags & ZIP_FLAG_STRONG_ENCRYPTION) !== 0
    ) {
      throw new Error(`Not a spreadsheet file (encrypted entry ${name}).`);
    }
    if (localMethod !== method) {
      throw new Error(`Not a spreadsheet file (zip entry ${name} corrupt).`);
    }
    const sizeMatches = (localSize: number, centralSizeValue: number): boolean =>
      localSize === centralSizeValue ||
      ((localFlags & ZIP_FLAG_DATA_DESCRIPTOR) !== 0 && localSize === 0);
    if (
      !sizeMatches(localCompressedSize, compressedSize) ||
      !sizeMatches(localUncompressedSize, uncompressedSize)
    ) {
      throw new Error(`Not a spreadsheet file (zip entry ${name} corrupt).`);
    }
    if (localOffset + 30 + localNameLength + localExtraLength > bytes.length) {
      throw new Error(`Not a spreadsheet file (zip entry ${name} corrupt).`);
    }
    const localName = decoder.decode(
      bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength),
    );
    if (localName !== name) {
      throw new Error(`Not a spreadsheet file (zip entry ${name} corrupt).`);
    }
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > bytes.length) {
      throw new Error(`Not a spreadsheet file (zip entry ${name} corrupt).`);
    }
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    const data = name.endsWith("/")
      ? new Uint8Array(0)
      : method === 0
        ? compressed.slice()
        : await inflateRaw(compressed, uncompressedSize, name);
    if (data.byteLength !== uncompressedSize) {
      throw new Error(`Not a spreadsheet file (zip entry ${name} corrupt).`);
    }
    entries.push({
      name,
      method: method === 8 ? 8 : 0,
      data,
      passthrough: compressed.slice(),
      crc,
    });
  }
  if (cursor !== centralEnd) {
    throw new Error("Not a spreadsheet file (zip directory corrupt).");
  }
  return entries;
}

const FIXED_DOS_TIME = 0;
const FIXED_DOS_DATE = (40 << 9) | (1 << 5) | 1; // 2020-01-01, keeps output deterministic.

async function writeZipEntries(entries: readonly ZipEntry[]): Promise<Uint8Array> {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new Error("Spreadsheet has too many package entries to write.");
  }
  const encoder = textEncoder();
  const chunks: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const writeChunk = (chunk: Uint8Array): void => {
    chunks.push(chunk);
    offset += chunk.length;
  };
  const header = new DataView(new ArrayBuffer(30));
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const payload = entry.passthrough ?? (await deflateRaw(entry.data));
    const method: 0 | 8 = entry.passthrough ? entry.method : entry.data.length > 0 ? 8 : 0;
    const stored = entry.passthrough ?? payload;
    const crc = entry.passthrough ? entry.crc : crc32(entry.data);
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(6, 1 << 11, true); // UTF-8 names.
    header.setUint16(8, method, true);
    header.setUint16(10, FIXED_DOS_TIME, true);
    header.setUint16(12, FIXED_DOS_DATE, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, stored.length, true);
    header.setUint32(22, entry.data.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);
    const localOffset = offset;
    writeChunk(new Uint8Array(header.buffer.slice(0)));
    writeChunk(nameBytes);
    writeChunk(stored);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 1 << 11, true);
    central.setUint16(10, method, true);
    central.setUint16(12, FIXED_DOS_TIME, true);
    central.setUint16(14, FIXED_DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, stored.length, true);
    central.setUint32(24, entry.data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint16(30, 0, true);
    central.setUint16(32, 0, true);
    central.setUint16(34, 0, true);
    central.setUint16(36, 0, true);
    central.setUint32(38, 0, true);
    central.setUint32(42, localOffset, true);
    centralParts.push(new Uint8Array(central.buffer.slice(0)), nameBytes);
  }
  const centralStart = offset;
  for (const part of centralParts) writeChunk(part);
  const centralSize = offset - centralStart;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);
  writeChunk(new Uint8Array(end.buffer.slice(0)));
  const output = new Uint8Array(offset);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return output;
}

function entryText(entries: readonly ZipEntry[], name: string): string | null {
  const entry = entries.find((candidate) => candidate.name === name);
  return entry ? textDecoder().decode(entry.data) : null;
}

function worksheetEntryNames(entries: readonly ZipEntry[]): string[] {
  return entries
    .map((entry) => entry.name)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
}

/**
 * Parse any .xlsx into its sheet names plus one sheet's grid. The first
 * sheet is the editable one; other sheets are readable so saves can verify
 * they round-trip untouched.
 */
export async function parseSpreadsheet(
  bytes: Uint8Array,
  sheetIndex = 0,
): Promise<ParsedSpreadsheet> {
  const entries = await readZipEntries(bytes);
  const workbookXml = entryText(entries, "xl/workbook.xml");
  if (!workbookXml) throw new Error("Not a spreadsheet file (workbook missing).");
  const workbookRelsXml = entryText(entries, "xl/_rels/workbook.xml.rels") ?? "";
  const sharedStringsXml = entryText(entries, "xl/sharedStrings.xml") ?? "";
  const sharedStrings = sharedStringsXml ? parseSharedStrings(sharedStringsXml) : [];
  const numberFormats = parseNumberFormats(entryText(entries, "xl/styles.xml"));
  const date1904 = parseDate1904(workbookXml);
  let targets = parseSheetTargets(workbookXml, workbookRelsXml);
  if (targets.length === 0) {
    targets = worksheetEntryNames(entries).map((entry, index) => ({
      name: `Sheet${index + 1}`,
      entry,
    }));
  }
  if (targets.length === 0) throw new Error("Not a spreadsheet file (no worksheets).");
  const first = targets[sheetIndex] ?? targets[0];
  if (!first) throw new Error("Not a spreadsheet file (no worksheets).");
  const sheetXml = entryText(entries, first.entry);
  if (!sheetXml) throw new Error("Not a spreadsheet file (worksheet missing).");
  const rows = parseSheetGrid(sheetXml, sharedStrings, { numberFormats, date1904 });
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (rows.length * columnCount > SHEET_GRID_MAX_CELLS) {
    throw new Error(
      `This sheet spans ${rows.length} rows by ${columnCount} columns, which is too large to show as an editable grid.`,
    );
  }
  return {
    sheetNames: targets.map((target) => target.name),
    activeSheetName: first.name,
    rows,
  };
}

const SPREADSHEET_GRID_MAX_CHARS_PER_CELL = 32_767;
/** Largest editable grid (rows times columns) before the UI refuses to render it. */
const SHEET_GRID_MAX_CELLS = 250_000;

const CANONICAL_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

/**
 * Excel General-style display for a canonical number: flight-artifact
 * decimals like 70.900000000000006 read as 70.9. By default only applies
 * when the formatted text parses back to the identical double, so saving a
 * parsed value never mutates it. Computed formula results pass
 * `{ coerce: true }`: display precision wins because the formula stays the
 * source of truth and Excel recalculates cached values on open anyway.
 */
export function formatSpreadsheetNumber(text: string, options: { coerce?: boolean } = {}): string {
  if (!CANONICAL_NUMBER.test(text)) return text;
  const value = Number(text);
  if (!Number.isFinite(value)) return text;
  if (Number.isInteger(value)) return String(value);
  const rounded = String(Number(value.toPrecision(15)));
  if (options.coerce) return rounded;
  return Number(rounded) === value ? rounded : text;
}

export type SpreadsheetCellInput =
  | { kind: "empty" }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "text"; value: string };

/**
 * Turn edited text back into a typed cell without guessing (the
 * cellInputFromText policy): canonical numbers become numbers so "02134" and
 * "1,000" stay text, TRUE/FALSE become booleans, and everything else is text.
 * Text is never promoted to a formula: the editor cannot tell a typed
 * formula from imported text that starts with "=", so nothing saved here is
 * executable.
 */
export function spreadsheetCellInputFromText(text: string): SpreadsheetCellInput {
  if (text === "") return { kind: "empty" };
  if (text === "TRUE") return { kind: "boolean", value: true };
  if (text === "FALSE") return { kind: "boolean", value: false };
  if (CANONICAL_NUMBER.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) return { kind: "number", value };
  }
  return { kind: "text", value: text };
}

/**
 * Excel error literals: cached formula errors round-trip with an error type
 * instead of degrading to text.
 */
const SPREADSHEET_ERROR_LITERALS = new Set([
  "#DIV/0!",
  "#N/A",
  "#NAME?",
  "#NULL!",
  "#NUM!",
  "#REF!",
  "#VALUE!",
  "#ERROR!",
  "#CYCLE!",
  "#BLOCKED!",
]);

function buildSheetXml(
  grid: readonly (readonly string[])[],
  computed?: readonly (readonly string[] | undefined)[] | undefined,
): string {
  const rows = grid
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, colIndex) => {
          const ref = `${columnIndexToLetters(colIndex)}${rowIndex + 1}`;
          // Grid text starting with "=" is a formula body. It is written as
          // <f> with the live computed display as the cached <v> so Excel and
          // Sheets keep calculating it. Without computed values (fixtures),
          // cells stay plain text.
          if (computed !== undefined && cell.startsWith("=") && cell.trim().length > 1) {
            const body = cell.slice(1);
            const cached = computed[rowIndex]?.[colIndex];
            if (cached === undefined || cached === "") {
              return `<c r="${ref}"><f>${escapeSpreadsheetXml(body)}</f></c>`;
            }
            if (SPREADSHEET_ERROR_LITERALS.has(cached)) {
              return `<c r="${ref}" t="e"><f>${escapeSpreadsheetXml(body)}</f><v>${cached}</v></c>`;
            }
            const cachedInput = spreadsheetCellInputFromText(cached);
            if (cachedInput.kind === "number") {
              return `<c r="${ref}"><f>${escapeSpreadsheetXml(body)}</f><v>${cachedInput.value}</v></c>`;
            }
            if (cachedInput.kind === "boolean") {
              return `<c r="${ref}" t="b"><f>${escapeSpreadsheetXml(body)}</f><v>${cachedInput.value ? 1 : 0}</v></c>`;
            }
            return `<c r="${ref}" t="str"><f>${escapeSpreadsheetXml(body)}</f><v>${escapeSpreadsheetXml(cached)}</v></c>`;
          }
          const input = spreadsheetCellInputFromText(cell);
          if (input.kind === "empty") return `<c r="${ref}"/>`;
          if (input.kind === "number") return `<c r="${ref}"><v>${input.value}</v></c>`;
          if (input.kind === "boolean") {
            return `<c r="${ref}" t="b"><v>${input.value ? 1 : 0}</v></c>`;
          }
          if (input.value.length > SPREADSHEET_GRID_MAX_CHARS_PER_CELL) {
            throw new Error(
              `Cell ${ref} holds ${input.value.length} characters of text; Excel allows 32,767. Shorten it or split it across cells.`,
            );
          }
          const preserve = /^\s|\s$|\n/.test(input.value) ? ' xml:space="preserve"' : "";
          return (
            `<c r="${ref}" t="inlineStr"><is><t${preserve}>` +
            `${escapeSpreadsheetXml(input.value)}</t></is></c>`
          );
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  const lastRef =
    grid.length > 0 && (grid[0]?.length ?? 0) > 0
      ? `${columnIndexToLetters((grid[0]?.length ?? 1) - 1)}${grid.length}`
      : "A1";
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${SPREADSHEETML_NS}"><dimension ref="A1:${lastRef}"/>` +
    `<sheetViews><sheetView workbookViewId="0"/></sheetViews>` +
    `<sheetData>${rows}</sheetData></worksheet>`
  );
}

function contentTypesXml(sheetCount: number): string {
  const overrides = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ` +
      `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxml-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ` +
    `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `${overrides}</Types>`
  );
}

function rootRelsXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PACKAGE_REL_NS}">` +
    `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_REL}" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function workbookXml(sheetNames: readonly string[]): string {
  const sheets = sheetNames
    .map(
      (name, index) =>
        `<sheet name="${escapeSpreadsheetXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="${SPREADSHEETML_NS}" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheets}</sheets></workbook>`
  );
}

function workbookRelsXml(sheetCount: number): string {
  const rels = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" ` +
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` +
      `Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="${PACKAGE_REL_NS}">${rels}</Relationships>`
  );
}

function packageEntries(sheets: readonly SpreadsheetWorkbookInput[]): ZipEntry[] {
  const encoder = textEncoder();
  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      method: 8,
      data: encoder.encode(contentTypesXml(sheets.length)),
      passthrough: null,
      crc: 0,
    },
    {
      name: "_rels/.rels",
      method: 8,
      data: encoder.encode(rootRelsXml()),
      passthrough: null,
      crc: 0,
    },
    {
      name: "xl/workbook.xml",
      method: 8,
      data: encoder.encode(workbookXml(sheets.map((sheet) => sheet.name))),
      passthrough: null,
      crc: 0,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      method: 8,
      data: encoder.encode(workbookRelsXml(sheets.length)),
      passthrough: null,
      crc: 0,
    },
  ];
  sheets.forEach((sheet, sheetIndex) => {
    entries.push({
      name: `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      method: 8,
      data: encoder.encode(buildSheetXml(normalizeSpreadsheetGrid(sheet.rows))),
      passthrough: null,
      crc: 0,
    });
  });
  return entries;
}

/** Build a single-sheet workbook from a grid. */
export async function createSpreadsheet(
  rows: readonly (readonly string[])[],
  sheetName = "Sheet1",
): Promise<Uint8Array> {
  return createSpreadsheetWorkbook([{ name: sheetName, rows }]);
}

/** Build a multi-sheet workbook. The first sheet is the editable one. */
export async function createSpreadsheetWorkbook(
  sheets: readonly SpreadsheetWorkbookInput[],
): Promise<Uint8Array> {
  const names = sheets.length > 0 ? sheets : [{ name: "Sheet1", rows: [] as string[][] }];
  return writeZipEntries(packageEntries(names));
}

/**
 * Replace the first sheet's grid, preserving every other package entry's
 * payload bytes verbatim so non-first sheets round-trip untouched. The
 * optional computed grid carries live formula results, which are written as
 * cached values next to each formula body.
 */
export async function serializeSpreadsheet(
  originalBytes: Uint8Array,
  rows: readonly (readonly string[])[],
  computed?: readonly (readonly string[] | undefined)[] | undefined,
): Promise<Uint8Array> {
  const entries = await readZipEntries(originalBytes);
  const workbookXmlText = entryText(entries, "xl/workbook.xml");
  if (!workbookXmlText) throw new Error("Not a spreadsheet file (workbook missing).");
  const workbookRelsXml = entryText(entries, "xl/_rels/workbook.xml.rels") ?? "";
  let targets = parseSheetTargets(workbookXmlText, workbookRelsXml);
  if (targets.length === 0) {
    targets = worksheetEntryNames(entries).map((entry, index) => ({
      name: `Sheet${index + 1}`,
      entry,
    }));
  }
  const first = targets[0];
  if (!first) throw new Error("Not a spreadsheet file (no worksheets).");
  const target = entries.find((entry) => entry.name === first.entry);
  if (!target) throw new Error("Not a spreadsheet file (worksheet missing).");
  target.data = textEncoder().encode(buildSheetXml(normalizeSpreadsheetGrid(rows), computed));
  target.passthrough = null;
  target.crc = 0;
  target.method = 8;
  return writeZipEntries(entries);
}
