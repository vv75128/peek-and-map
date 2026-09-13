export interface SymbolRecord {
  id: number;
  name: string;
  kind: number;
  file_path: string;
  range_start_line: number;
  range_start_char: number;
  range_end_line: number;
  range_end_char: number;
  selection_start_line: number;
  selection_start_char: number;
  selection_end_line: number;
  selection_end_char: number;
}

export class SymbolDatabase {
  private symbolsByFile = new Map<string, SymbolRecord[]>();

  async init(): Promise<void> {
    // 内存版，不需要初始化
  }

  insertSymbols(symbols: SymbolRecord[]): void {
    if (symbols.length === 0) { return; }
    const filePath = symbols[0].file_path;
    this.symbolsByFile.set(filePath, symbols);
  }

  getSymbolsForFile(filePath: string): SymbolRecord[] {
    return this.symbolsByFile.get(filePath) || [];
  }

  findEnclosingSymbol(filePath: string, line: number): SymbolRecord | undefined {
    const symbols = this.getSymbolsForFile(filePath);
    let best: SymbolRecord | undefined;
    let minSize = Number.MAX_SAFE_INTEGER;
    for (const sym of symbols) {
      if (sym.range_start_line <= line && sym.range_end_line >= line) {
        const size = sym.range_end_line - sym.range_start_line;
        if (size < minSize) {
          minSize = size;
          best = sym;
        }
      }
    }
    return best;
  }

  deleteFile(filePath: string): void {
    this.symbolsByFile.delete(filePath);
  }

  clear(): void {
    this.symbolsByFile.clear();
  }
}