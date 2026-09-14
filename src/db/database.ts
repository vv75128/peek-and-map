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

export interface WordLocation {
  file_path: string;
  line: number;
  char: number;
}

export class SymbolDatabase {
  private symbolsByFile = new Map<string, SymbolRecord[]>();
  private wordIndex = new Map<string, WordLocation[]>();
  private lastIndexedTime = 0;

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

  /** 写入倒排索引：word -> locations */
  addWordLocations(word: string, locations: WordLocation[]): void {
    if (locations.length === 0) { return; }
    let list = this.wordIndex.get(word);
    if (!list) {
      list = [];
      this.wordIndex.set(word, list);
    }
    list.push(...locations);
  }

  /** 按 word 查倒排索引 */
  findWordLocations(word: string): WordLocation[] {
    return this.wordIndex.get(word) || [];
  }

  /** 清空某个文件的倒排索引 */
  clearWordIndexForFile(filePath: string): void {
    for (const [word, locations] of this.wordIndex.entries()) {
      const filtered = locations.filter(l => l.file_path !== filePath);
      if (filtered.length === 0) {
        this.wordIndex.delete(word);
      } else {
        this.wordIndex.set(word, filtered);
      }
    }
  }

  /** 倒排索引里的词条数量 */
  getWordCount(): number {
    return this.wordIndex.size;
  }

  /** 清空倒排索引 */
  clearWordIndex(): void {
    this.wordIndex.clear();
  }

  /** 导出为可序列化的对象 */
  toJSON(): { symbols: Record<string, SymbolRecord[]>; words: Record<string, WordLocation[]>; lastIndexedTime: number } {
    const symbols: Record<string, SymbolRecord[]> = {};
    for (const [filePath, syms] of this.symbolsByFile.entries()) {
      symbols[filePath] = syms;
    }
    const words: Record<string, WordLocation[]> = {};
    for (const [word, locs] of this.wordIndex.entries()) {
      words[word] = locs;
    }
    return { symbols, words, lastIndexedTime: this.lastIndexedTime };
  }

  /** 从对象恢复 */
  fromJSON(data: { symbols: Record<string, SymbolRecord[]>; words: Record<string, WordLocation[]>; lastIndexedTime?: number }): void {
    this.symbolsByFile.clear();
    for (const [filePath, syms] of Object.entries(data.symbols || {})) {
      this.symbolsByFile.set(filePath, syms);
    }
    this.wordIndex.clear();
    for (const [word, locs] of Object.entries(data.words || {})) {
      this.wordIndex.set(word, locs);
    }
    this.lastIndexedTime = data.lastIndexedTime || 0;
  }

  /** 当前索引的文件数量 */
  getFileCount(): number {
    return this.symbolsByFile.size;
  }

  /** 获取所有已索引文件的路径 */
  getAllFilePaths(): string[] {
    return [...this.symbolsByFile.keys()];
  }

  /** 获取上次索引时间 */
  getLastIndexedTime(): number {
    return this.lastIndexedTime;
  }

  /** 设置上次索引时间 */
  setLastIndexedTime(t: number): void {
    this.lastIndexedTime = t;
  }
}
