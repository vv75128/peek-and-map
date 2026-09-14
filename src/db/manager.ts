import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { SymbolDatabase } from './database';
import { SymbolIndexer } from './indexer';

const execFileAsync = promisify(execFile);

export class DatabaseManager {
  private db: SymbolDatabase;
  private indexer: SymbolIndexer;
  private initialized = false;
  private _progressItem: vscode.StatusBarItem;
  private _storageFile!: string;

  constructor(private context: vscode.ExtensionContext) {
    this.db = new SymbolDatabase();
    this.indexer = new SymbolIndexer(this.db);
    this._progressItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this._updateStorageFile();
  }

  private _updateStorageFile(): void {
    const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (wsRoot) {
      const indexDir = path.join(wsRoot, '.peek-and-map');
      this._storageFile = path.join(indexDir, 'symbols.json');
    } else {
      this._storageFile = path.join(this.context.globalStorageUri.fsPath, 'symbols.json');
    }
  }

  async init(): Promise<void> {
    if (this.initialized) { return; }
    await this.db.init();
    this.initialized = true;

    const loaded = await this._loadFromDisk();
    if (loaded) {
      console.log('[DB] 从磁盘加载索引成功');
      this._progressItem.hide();
    } else {
      (async () => {
        try {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在索引 C/C++ 符号',
            cancellable: false,
          }, async (progress) => {
            let lastPercent = 0;

            // 阶段 1：符号索引 — 占 0%–50%
            await this.indexer.indexWorkspace((done, total, currentFile) => {
              const percent = total > 0 ? Math.floor((done / total) * 50) : 0;
              const increment = percent - lastPercent;
              lastPercent = percent;
              progress.report({
                increment,
                message: `符号：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
              });
            });

            // 阶段 2：倒排索引 — 占 50%–100%
            progress.report({ message: '正在构建倒排索引...' });
            const rgPath = await this._findRipgrep();
            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            if (rgPath && wsRoot) {
              let lastPercent2 = lastPercent;
              await this.indexer.buildWordIndex(rgPath, wsRoot, (done, total, currentFile) => {
                const percent = total > 0 ? 50 + Math.floor((done / total) * 50) : lastPercent2;
                const increment = percent - lastPercent2;
                lastPercent2 = percent;
                progress.report({
                  increment,
                  message: `倒排索引：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
                });
              });
            }

            this.db.setLastIndexedTime(Date.now());
            await this._saveToDisk();
          });
          this._progressItem.hide();
        } catch (err: any) {
          console.error('[DB] Indexing failed', err);
          this._progressItem.text = `$(error) 索引失败`;
          setTimeout(() => this._progressItem.hide(), 5000);
        }
      })();
    }

    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (/\.(c|h|cpp|hpp|cc|cxx|hxx)$/.test(doc.fileName)) {
        await this.indexer.indexFile(doc.uri);
        this.db.setLastIndexedTime(Date.now());
        await this._saveToDisk();
      }
    });
  }

  /** 全量重建索引 */
  async reindexAll(): Promise<void> {
    this.db.clear();
    this.db.clearWordIndex();
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Peek and Map：全量重建索引',
      cancellable: false,
    }, async (progress) => {
      let lastPercent = 0;

      // 阶段 1：符号索引 — 占 0%–50%
      await this.indexer.indexWorkspace((done, total, currentFile) => {
        const percent = total > 0 ? Math.floor((done / total) * 50) : 0;
        const increment = percent - lastPercent;
        lastPercent = percent;
        progress.report({
          increment,
          message: `符号：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
        });
      });

      // 阶段 2：倒排索引 — 占 50%–100%
      progress.report({ message: '正在构建倒排索引...' });
      const rgPath = await this._findRipgrep();
      const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
      if (rgPath && wsRoot) {
        let lastPercent2 = lastPercent;
        await this.indexer.buildWordIndex(rgPath, wsRoot, (done, total, currentFile) => {
          const percent = total > 0 ? 50 + Math.floor((done / total) * 50) : lastPercent2;
          const increment = percent - lastPercent2;
          lastPercent2 = percent;
          progress.report({
            increment,
            message: `倒排索引：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
          });
        });
      }

      this.db.setLastIndexedTime(Date.now());
      await this._saveToDisk();
    });
  }

  /** 增量索引：只重新索引修改过的文件，返回更新的文件数 */
  async reindexChanged(): Promise<number> {
    const since = this.db.getLastIndexedTime();
    let count = 0;
    await vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: 'Peek and Map：增量索引',
      cancellable: false,
    }, async (progress) => {
      let lastPercent = 0;
      count = await this.indexer.indexChangedFiles(since, (done, total, currentFile) => {
        const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
        const increment = percent - lastPercent;
        lastPercent = percent;
        progress.report({
          increment,
          message: `${done}/${total} (${percent}%)`,
        });
      });
      this.db.setLastIndexedTime(Date.now());
      await this._saveToDisk();
    });
    return count;
  }

  private async _findRipgrep(): Promise<string | null> {
    const appRoot = vscode.env.appRoot;
    const rgName = process.platform === 'win32' ? 'rg.exe' : 'rg';
    const platformDir = `${process.platform}-${process.arch}`;

    const candidates: string[] = [
      path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', platformDir, rgName),
      path.join(appRoot, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', platformDir, rgName),
      path.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', rgName),
      path.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', rgName),
    ];

    for (const c of candidates) {
      try {
        await execFileAsync(c, ['--version']);
        return c;
      } catch { /* 试下一个 */ }
    }

    try {
      await execFileAsync(rgName, ['--version']);
      return rgName;
    } catch { /* 没有 */ }

    return null;
  }

  private async _loadFromDisk(): Promise<boolean> {
    try {
      if (!fs.existsSync(this._storageFile)) { return false; }
      const data = await fs.promises.readFile(this._storageFile, 'utf-8');
      const obj = JSON.parse(data);
      if (!obj || typeof obj !== 'object') { return false; }
      this.db.fromJSON(obj);
      return this.db.getFileCount() > 0 || this.db.getWordCount() > 0;
    } catch (e) {
      console.warn('[DB] 加载索引失败', e);
      return false;
    }
  }

  private async _saveToDisk(): Promise<void> {
    try {
      const dir = path.dirname(this._storageFile);
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true });
      }
      const data = JSON.stringify(this.db.toJSON());
      await fs.promises.writeFile(this._storageFile, data, 'utf-8');
    } catch (e) {
      console.warn('[DB] 保存索引失败', e);
    }
  }

  getDb(): SymbolDatabase {
    return this.db;
  }

  dispose(): void {
    this._progressItem.dispose();
  }
}
