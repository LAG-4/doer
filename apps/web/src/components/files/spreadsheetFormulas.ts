import {
  formatSpreadsheetNumber,
  spreadsheetCellInputFromText,
} from "@t3tools/shared/spreadsheetWorkbook";

export interface SpreadsheetFormulaCell {
  readonly row: number;
  readonly col: number;
  /** Formula body without the leading "=". */
  readonly body: string;
}

/** Raw grid text that is a formula candidate: "=" followed by a body. */
export function isSpreadsheetFormulaCell(text: string): boolean {
  return text.startsWith("=") && text.trim().length > 1;
}

export function collectSpreadsheetFormulas(
  rows: readonly (readonly string[])[],
): SpreadsheetFormulaCell[] {
  const formulas: SpreadsheetFormulaCell[] = [];
  rows.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      if (isSpreadsheetFormulaCell(cell)) {
        formulas.push({ row: rowIndex, col: colIndex, body: cell.slice(1) });
      }
    });
  });
  return formulas;
}

// Functions that reach outside the workbook when they evaluate. Sync
// evaluation cannot fetch, and these overrides make that explicit with a
// dedicated error instead of whatever each function would do.
const BLOCKED_FUNCTIONS = ["WEBSERVICE", "FILTERXML", "RTD"] as const;

export const SPREADSHEET_CYCLE_ERROR = "#CYCLE!";
export const SPREADSHEET_BLOCKED_ERROR = "#BLOCKED!";

/** Display text for a computed formula value. */
export function formatSpreadsheetComputedValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "#NUM!";
    return formatSpreadsheetNumber(String(value), { coerce: true });
  }
  if (typeof value === "string") return value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "#VALUE!";
    const iso = value.toISOString();
    return iso.slice(11, 19) === "00:00:00" ? iso.slice(0, 10) : iso.slice(0, 19).replace("T", " ");
  }
  if (Array.isArray(value)) return "#VALUE!";
  return String(value);
}

export interface SpreadsheetFormulaPosition {
  readonly row: number;
  readonly col: number;
  readonly sheet: string;
}

export interface SpreadsheetFormulaEngine {
  createParser(hooks: {
    onCell: (ref: { sheet: string; row: number; col: number }) => unknown;
    onRange: (ref: {
      sheet: string;
      from: { row: number; col: number };
      to: { row: number; col: number };
    }) => unknown[][];
  }): {
    parse(inputText: string, position: SpreadsheetFormulaPosition): unknown;
  };
  parseDependencies(
    body: string,
    position: SpreadsheetFormulaPosition,
  ): Array<
    | { row: number; col: number }
    | { from: { row: number; col: number }; to: { row: number; col: number } }
  >;
  isFormulaError(value: unknown): boolean;
  formulaErrorCode(value: unknown): string;
  blockedError(): unknown;
}

interface EngineParserOptions {
  functions?: Record<string, (...args: never[]) => unknown>;
  onCell?: (ref: { sheet: string; row: number; col: number }) => unknown;
  onRange?: (ref: {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }) => unknown[][];
}

interface EngineParser {
  parse(inputText: string, position: SpreadsheetFormulaPosition): unknown;
}

interface EngineDepRef {
  row?: number;
  col?: number;
  sheet?: string;
  from?: { row: number; col: number };
  to?: { row: number; col: number };
}

interface EngineModules {
  new (options?: EngineParserOptions): EngineParser;
  DepParser?: new () => {
    parse(inputText: string, position: SpreadsheetFormulaPosition): EngineDepRef[];
  };
  FormulaError?: new (error: string, message?: string) => Error & { error: string };
}

let cachedEngine: Promise<SpreadsheetFormulaEngine> | null = null;

/**
 * Lazily load the MIT formula engine (fast-formula-parser). The import only
 * runs for sheets that actually contain formulas, so plain sheets never pay
 * for the dependency. The untyped CJS module is validated at runtime.
 */
export function loadSpreadsheetFormulaEngine(): Promise<SpreadsheetFormulaEngine> {
  if (!cachedEngine) {
    cachedEngine = import("fast-formula-parser").then((mod: unknown) => {
      const namespace = mod as { default?: unknown };
      const candidate = namespace.default ?? mod;
      if (typeof candidate !== "function") {
        throw new Error("Spreadsheet formula engine failed to load.");
      }
      const modules = candidate as EngineModules;
      const FormulaParserCtor = modules;
      const DepParserCtor = modules.DepParser;
      const FormulaErrorCtor = modules.FormulaError;
      if (typeof DepParserCtor !== "function" || typeof FormulaErrorCtor !== "function") {
        throw new Error("Spreadsheet formula engine failed to load.");
      }
      const blockedFunctions: Record<string, (...args: never[]) => unknown> = {};
      for (const name of BLOCKED_FUNCTIONS) {
        blockedFunctions[name] = (): unknown => {
          throw new FormulaErrorCtor(SPREADSHEET_BLOCKED_ERROR);
        };
      }
      const isError = (value: unknown): value is Error & { error: string } =>
        value instanceof FormulaErrorCtor;
      return {
        createParser: (hooks) =>
          new FormulaParserCtor({
            functions: blockedFunctions,
            onCell: hooks.onCell,
            onRange: hooks.onRange,
          }),
        parseDependencies: (body, position) => {
          const refs = new DepParserCtor().parse(body, {
            row: position.row,
            col: position.col,
            sheet: position.sheet,
          });
          return refs.map((ref) =>
            ref.from && ref.to
              ? { from: ref.from, to: ref.to }
              : { row: ref.row ?? 0, col: ref.col ?? 0 },
          );
        },
        isFormulaError: isError,
        formulaErrorCode: (value) => (isError(value) ? value.error : "#ERROR!"),
        blockedError: () => new FormulaErrorCtor(SPREADSHEET_BLOCKED_ERROR),
      };
    });
    cachedEngine.catch(() => {
      cachedEngine = null;
    });
  }
  return cachedEngine;
}

function typedRawValue(text: string): string | number | boolean | null {
  const input = spreadsheetCellInputFromText(text);
  if (input.kind === "empty") return null;
  return input.value;
}

/**
 * Evaluate every formula in row-major dependency order and return a display
 * grid: formula cells show computed text, everything else is untouched.
 * Circular references display #CYCLE! (propagated to dependents),
 * unparseable bodies display #ERROR!. Without an engine (failed load), the
 * raw grid passes through so formulas still read as text.
 */
export function evaluateSpreadsheetFormulas(
  rows: readonly (readonly string[])[],
  formulas: readonly SpreadsheetFormulaCell[],
  sheetName: string,
  engine?: SpreadsheetFormulaEngine | null,
): string[][] {
  const displays = rows.map((row) => [...row]);
  if (formulas.length === 0 || !engine) return displays;
  const rowCount = rows.length;
  const colCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const sameSheet = (sheet: string | undefined): boolean =>
    sheet === undefined || sheet.toLowerCase() === sheetName.toLowerCase();

  // Dependency order via the engine's dependency parser. Ranges clamp to the
  // used grid so whole-column references cannot explode the graph.
  const keyOf = (row: number, col: number): string => `${row}:${col}`;
  const formulaByKey = new Map<string, SpreadsheetFormulaCell>();
  for (const formula of formulas) formulaByKey.set(keyOf(formula.row, formula.col), formula);
  const dependencies = new Map<string, Set<string>>();
  for (const formula of formulas) {
    const key = keyOf(formula.row, formula.col);
    const deps = new Set<string>();
    // Unparseable bodies get no edges: evaluation below produces the true
    // error (#ERROR!, #NAME?) instead of a placeholder.
    try {
      for (const ref of engine.parseDependencies(formula.body, {
        row: formula.row + 1,
        col: formula.col + 1,
        sheet: sheetName,
      })) {
        const cells: Array<{ row: number; col: number }> =
          "from" in ref
            ? (() => {
                const list: Array<{ row: number; col: number }> = [];
                const firstRow = Math.max(1, Math.min(ref.from.row, ref.to.row));
                const lastRow = Math.min(rowCount, Math.max(ref.from.row, ref.to.row));
                const firstCol = Math.max(1, Math.min(ref.from.col, ref.to.col));
                const lastCol = Math.min(colCount, Math.max(ref.from.col, ref.to.col));
                for (let r = firstRow; r <= lastRow; r += 1) {
                  for (let c = firstCol; c <= lastCol; c += 1) {
                    list.push({ row: r - 1, col: c - 1 });
                  }
                }
                return list;
              })()
            : [{ row: ref.row - 1, col: ref.col - 1 }];
        for (const cell of cells) {
          if (cell.row < 0 || cell.col < 0 || cell.row >= rowCount || cell.col >= colCount) {
            continue;
          }
          const depKey = keyOf(cell.row, cell.col);
          if (depKey !== key && formulaByKey.has(depKey)) deps.add(depKey);
        }
      }
    } catch {
      // No edges: evaluation below produces the true error.
    }
    dependencies.set(key, deps);
  }

  // Kahn's algorithm; leftovers are circular (or downstream of circular).
  const order: string[] = [];
  const queue: string[] = [];
  const indegree = new Map<string, number>();
  for (const [key, deps] of dependencies) {
    indegree.set(key, deps.size);
    if (deps.size === 0) queue.push(key);
  }
  const dependents = new Map<string, string[]>();
  for (const [key, deps] of dependencies) {
    for (const dep of deps) {
      const list = dependents.get(dep) ?? [];
      list.push(key);
      dependents.set(dep, list);
    }
  }
  while (queue.length > 0) {
    const key = queue.shift() as string;
    order.push(key);
    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (indegree.get(dependent) ?? 1) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }
  const ordered = new Set(order);
  const cyclic = [...dependencies.keys()].filter((key) => !ordered.has(key));

  const computed = new Map<string, unknown>();
  const setDisplay = (key: string, text: string): void => {
    const [row, col] = key.split(":").map(Number);
    if (
      row === undefined ||
      col === undefined ||
      !Number.isInteger(row) ||
      !Number.isInteger(col) ||
      row < 0 ||
      col < 0 ||
      row >= rowCount ||
      col >= colCount
    ) {
      return;
    }
    const line = displays[row];
    if (line) line[col] = text;
  };
  for (const key of cyclic) {
    computed.set(key, SPREADSHEET_CYCLE_ERROR);
    setDisplay(key, SPREADSHEET_CYCLE_ERROR);
  }

  const parser = engine.createParser({
    onCell: (ref) => {
      if (!sameSheet(ref.sheet)) return null;
      const row = ref.row - 1;
      const col = ref.col - 1;
      if (row < 0 || col < 0 || row >= rowCount || col >= colCount) return null;
      const depKey = keyOf(row, col);
      if (computed.has(depKey)) return computed.get(depKey);
      return typedRawValue(rows[row]?.[col] ?? "");
    },
    onRange: (ref) => {
      if (!sameSheet(ref.sheet)) return [[]];
      const firstRow = Math.max(1, Math.min(ref.from.row, ref.to.row)) - 1;
      const lastRow = Math.min(rowCount, Math.max(ref.from.row, ref.to.row)) - 1;
      const firstCol = Math.max(1, Math.min(ref.from.col, ref.to.col)) - 1;
      const lastCol = Math.min(colCount, Math.max(ref.from.col, ref.to.col)) - 1;
      const table: unknown[][] = [];
      for (let row = firstRow; row <= lastRow; row += 1) {
        const line: unknown[] = [];
        for (let col = firstCol; col <= lastCol; col += 1) {
          const depKey = keyOf(row, col);
          line.push(
            computed.has(depKey) ? computed.get(depKey) : typedRawValue(rows[row]?.[col] ?? ""),
          );
        }
        table.push(line);
      }
      return table;
    },
  });

  for (const key of order) {
    const formula = formulaByKey.get(key);
    if (!formula) continue;
    let result: unknown;
    try {
      result = parser.parse(formula.body, {
        row: formula.row + 1,
        col: formula.col + 1,
        sheet: sheetName,
      });
      if (engine.isFormulaError(result)) result = engine.formulaErrorCode(result);
    } catch (error) {
      result = engine.isFormulaError(error) ? engine.formulaErrorCode(error) : "#ERROR!";
    }
    computed.set(key, result);
    const display =
      typeof result === "string" && result.startsWith("#")
        ? result
        : formatSpreadsheetComputedValue(result);
    const line = displays[formula.row];
    if (line && formula.col < line.length) line[formula.col] = display;
  }
  return displays;
}
