import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SymbolDatabase, SymbolRecord, WordLocation } from './database';

const execFileAsync = promisify(execFile);

export class SymbolIndexer {
  constructor(private db: SymbolDatabase) {}

  /**
   * 读取 C_Cpp.files.exclude 配置，返回排除模式数组。
   */
  private _getCppExcludePatterns(): string[] {
    const patterns: string[] = ['**/node_modules/**'];
    try {
      const cppExclude = vscode.workspace
        .getConfiguration('C_Cpp')
        .get<Record<string, boolean>>('files.exclude', {});
      for (const [pattern, enabled] of Object.entries(cppExclude)) {
        if (enabled) {
          patterns.push(pattern);
        }
      }
    } catch { /* 忽略 */ }
    return patterns;
  }

  /**
   * 转成 findFiles 的 exclude glob（{} 包裹多个模式）。
   */
  private _getCppExcludeGlob(): string {
    return `{${this._getCppExcludePatterns().join(',')}}`;
  }

  async indexWorkspace(
    onProgress?: (done: number, total: number, currentFile: string) => void,
    isStale?: () => boolean
  ): Promise<void> {
    if (isStale?.()) { return; }

    const files = await vscode.workspace.findFiles(
      '**/*.{c,h,cpp,hpp,cc,cxx,hxx}',
      this._getCppExcludeGlob()
    );
    if (isStale?.()) { return; }

    const total = files.length;
    let done = 0;
    const concurrency = 6;

    for (let i = 0; i < files.length; i += concurrency) {
      // 每批开始前检查一次
      if (isStale?.()) { return; }

      const batch = files.slice(i, i + concurrency);
      await Promise.all(batch.map(async (file) => {
        // 批内每个文件也检查一次（并发执行时尽快退出）
        if (isStale?.()) { return; }
        await this.indexFile(file);
        done++;
        if (isStale?.()) { return; }
        onProgress?.(done, total, file.fsPath);
      }));
    }
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    try {
      // 并行：符号索引 + 打开文档
      const [symbols, doc] = await Promise.all([
        vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
          'vscode.executeDocumentSymbolProvider', uri
        ),
        vscode.workspace.openTextDocument(uri),
      ]);

      // 索引符号
      if (symbols && symbols.length > 0) {
        this.db.deleteFile(uri.fsPath);
        const records: SymbolRecord[] = [];
        this.flattenSymbols(symbols, uri.fsPath, records);
        this.db.insertSymbols(records);
      }

      // 倒排索引：按文件更新
      this.db.clearWordIndexForFile(uri.fsPath);
      const wordRegex = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
      const wordLocations = new Map<string, WordLocation[]>();
      for (let i = 0; i < doc.lineCount; i++) {
        const lineText = doc.lineAt(i).text;
        let match: RegExpExecArray | null;
        wordRegex.lastIndex = 0;
        while ((match = wordRegex.exec(lineText)) !== null) {
          const word = match[0];
          let list = wordLocations.get(word);
          if (!list) { list = []; wordLocations.set(word, list); }
          list.push({ file_path: uri.fsPath, line: i, char: match.index });
        }
      }
      for (const [word, locs] of wordLocations.entries()) {
        this.db.addWordLocations(word, locs);
      }
    } catch {
      // 忽略无法解析的文件
    }
  }

  async indexChangedFiles(
    since: number,
    onProgress?: (done: number, total: number, currentFile: string) => void,
    isStale?: () => boolean
  ): Promise<number> {
    if (isStale?.()) { return 0; }

    const files = await vscode.workspace.findFiles(
      '**/*.{c,h,cpp,hpp,cc,cxx,hxx}',
      this._getCppExcludeGlob()
    );
    if (isStale?.()) { return 0; }

    // 当前工作区里存在的文件路径集合
    const existingPaths = new Set<string>();
    for (const file of files) {
      existingPaths.add(file.fsPath);
    }

    // 清理已删除文件的索引
    const indexedPaths = this.db.getAllFilePaths();
    for (const indexedPath of indexedPaths) {
      if (isStale?.()) { return 0; }
      if (!existingPaths.has(indexedPath)) {
        this.db.deleteFile(indexedPath);
        this.db.clearWordIndexForFile(indexedPath);
      }
    }

    // 先统计需要更新的文件
    const sinceWithBuffer = since - 2000;
    const changedFiles: vscode.Uri[] = [];
    for (const file of files) {
      if (isStale?.()) { return 0; }
      try {
        const stat = await vscode.workspace.fs.stat(file);
        if (stat.mtime > sinceWithBuffer) {
          changedFiles.push(file);
        }
      } catch { /* 忽略无法访问的文件 */ }
    }

    // 再逐个索引并报告进度
    const total = changedFiles.length;
    let done = 0;
    for (const file of changedFiles) {
      if (isStale?.()) { return done; }
      await this.indexFile(file);
      done++;
      if (isStale?.()) { return done; }
      onProgress?.(done, total, file.fsPath);
    }
    return total;
  }

  /**
   * 用 rg 一次性扫描整个工作区，构建倒排索引。
   */
  async buildWordIndex(
    rgPath: string,
    wsRoot: string,
    onProgress?: (done: number, total: number, currentFile: string) => void,
    isStale?: () => boolean
  ): Promise<void> {
    if (isStale?.()) { return; }

    const excludePatterns = this._getCppExcludePatterns();
    const args = [
      '--json',
      '-o',
      '-e', '\\b[A-Za-z_][A-Za-z0-9_]*\\b',
      '--glob', '*.{c,h,cpp,hpp,cc,cxx,hxx}',
      ...excludePatterns.flatMap(p => ['--glob', `!${p}`]),
      wsRoot,
    ];

    let stdout = '';
    try {
      const result = await execFileAsync(rgPath, args, { maxBuffer: 100 * 1024 * 1024 });
      stdout = result.stdout;
    } catch (e: any) {
      // rg 返回非零退出码（比如没匹配到）也会抛异常，stdout 可能仍有内容
      stdout = e?.stdout || '';
    }

    if (isStale?.()) { return; }

    const lines = stdout.split('\n').filter(Boolean);
    const wordLocations = new Map<string, WordLocation[]>();
    let count = 0;

    for (const line of lines) {
      // 每 200 行检查一次过期，避免频繁调用
      if (count % 200 === 0 && isStale?.()) { return; }

      let match: any;
      try { match = JSON.parse(line); } catch { continue; }
      if (match.type !== 'match') { continue; }

      const data = match.data;
      if (!data || !data.path || !data.line_number) { continue; }

      const filePath = data.path.text;
      const lineNum = data.line_number - 1;
      const submatches = data.submatches || [];

      for (const submatch of submatches) {
        const word = submatch.match?.text;
        if (!word) { continue; }
        const startCol = submatch.start;
        let list = wordLocations.get(word);
        if (!list) {
          list = [];
          wordLocations.set(word, list);
        }
        list.push({ file_path: filePath, line: lineNum, char: startCol });
      }

      count++;
      if (count % 500 === 0) {
        onProgress?.(count, lines.length, data.path.text);
      }
    }

    // 写入数据库前最后检查一次
    if (isStale?.()) { return; }

    for (const [word, locs] of wordLocations.entries()) {
      if (isStale?.()) { return; }
      this.db.addWordLocations(word, locs);
    }
    onProgress?.(lines.length, lines.length, '');
  }

  private flattenSymbols(
    symbols: vscode.DocumentSymbol[],
    filePath: string,
    out: SymbolRecord[]
  ): void {
    for (const sym of symbols) {
      out.push({
        id: 0,
        name: sym.name,
        kind: sym.kind,
        file_path: filePath,
        range_start_line: sym.range.start.line,
        range_start_char: sym.range.start.character,
        range_end_line: sym.range.end.line,
        range_end_char: sym.range.end.character,
        selection_start_line: sym.selectionRange.start.line,
        selection_start_char: sym.selectionRange.start.character,
        selection_end_line: sym.selectionRange.end.line,
        selection_end_char: sym.selectionRange.end.character,
      });
      if (sym.children && sym.children.length > 0) {
        this.flattenSymbols(sym.children, filePath, out);
      }
    }
  }
}
