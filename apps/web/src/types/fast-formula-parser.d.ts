declare module "fast-formula-parser" {
  export interface FormulaPosition {
    row: number;
    col: number;
    sheet: string;
  }
  export interface FormulaCellRef extends FormulaPosition {}
  export interface FormulaRangeRef {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }
  export class FormulaError extends Error {
    readonly error: string;
  }
  export class DepParser {
    constructor(options?: { onVariable?: (name: string) => unknown });
    parse(inputText: string, position: FormulaPosition): Array<FormulaCellRef | FormulaRangeRef>;
  }
  export default class FormulaParser {
    constructor(options?: {
      functions?: Record<string, (...args: never[]) => unknown>;
      onCell?: (ref: FormulaCellRef) => unknown;
      onRange?: (ref: FormulaRangeRef) => unknown[][];
      onVariable?: (name: string) => unknown;
    });
    parse(inputText: string, position: FormulaPosition): unknown;
  }
}
