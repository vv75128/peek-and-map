import * as vscode from 'vscode';
import { SymbolDatabase } from './database';
import { SymbolIndexer } from './indexer';

export class DatabaseManager {
  private db: SymbolDatabase;
  private indexer: SymbolIndexer;
  private initialized = false;
  private _progressItem: vscode.StatusBarItem;

  constructor(private context: vscode.ExtensionContext) {
    this.db = new SymbolDatabase();
    this.indexer = new SymbolIndexer(this.db);
    this._progressItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  }

  async init(): Promise<void> {
    if (this.initialized) { return; }
    await this.db.init();
    this.initialized = true;

    setTimeout(() => {
      this._progressItem.text = `$(sync~spin) 正在索引 C/C++ 符号...`;
      this._progressItem.tooltip = 'Peek and Map 正在为工作区建立符号数据库，请稍候';
      this._progressItem.show();

      this.indexer.indexWorkspace().then(() => {
        this._progressItem.hide();
      }).catch(() => {
        this._progressItem.text = `$(error) 索引失败`;
        setTimeout(() => this._progressItem.hide(), 5000);
      });
    }, 10000);

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (/\.(c|h|cpp|hpp|cc|cxx|hxx)$/.test(doc.fileName)) {
        this.indexer.indexFile(doc.uri);
      }
    });
  }

  getDb(): SymbolDatabase {
    return this.db;
  }

  dispose(): void {
    this._progressItem.dispose();
  }
}