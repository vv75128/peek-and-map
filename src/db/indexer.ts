import * as vscode from 'vscode';
import { SymbolDatabase, SymbolRecord } from './database';

export class SymbolIndexer {
  constructor(private db: SymbolDatabase) {}

  async indexWorkspace(): Promise<void> {
    const files = await vscode.workspace.findFiles(
      '**/*.{c,h,cpp,hpp,cc,cxx,hxx}',
      '**/node_modules/**'
    );
    for (const file of files) {
      await this.indexFile(file);
    }
  }

  async indexFile(uri: vscode.Uri): Promise<void> {
    try {
      const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri
      );
      if (!symbols || symbols.length === 0) { return; }

      this.db.deleteFile(uri.fsPath);
      const records: SymbolRecord[] = [];
      this.flattenSymbols(symbols, uri.fsPath, records);
      this.db.insertSymbols(records);
    } catch {
      // 忽略无法解析的文件
    }
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