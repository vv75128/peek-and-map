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
  private _reindexing = false;

  /** 索引 generation：每次新索引自增，作废旧索引。 */
  private _indexGen = 0;
  /** 是否有索引正在跑（初次索引 / 全量重建 / 增量索引）。 */
  private _indexing = false;
  /** 当前活跃的进度条取消源；索引被 cancelIndex 作废时主动取消。 */
  private _activeProgressCancel: vscode.CancellationTokenSource | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.db = new SymbolDatabase();
    this.indexer = new SymbolIndexer(this.db);
    this._progressItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this._updateStorageFile();
  }

  // ── 索引取消机制 ─────────────────────────────────────────────────────────

  /** 开始一次新索引，作废旧索引，返回本次 generation。 */
  beginIndex(): number {
    return ++this._indexGen;
  }

  /** 检查本次索引是否已过期。 */
  isIndexStale(gen: number): boolean {
    return gen !== this._indexGen;
  }

  /**
   * 主动取消当前索引（点击新变量时调用）。
   * 同时取消正在显示的进度条 notification。
   */
  cancelIndex(): void {
    this._indexGen++;
    if (this._activeProgressCancel) {
      try { this._activeProgressCancel.cancel(); } catch (_) { /* ignore */ }
    }
  }

  /** 是否有索引正在跑。 */
  isIndexing(): boolean {
    return this._indexing;
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
        const gen = this.beginIndex();
        this._indexing = true;
        const cts = new vscode.CancellationTokenSource();
        this._activeProgressCancel = cts;
        try {
          await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: '正在索引 C/C++ 符号',
            cancellable: true,
          }, async (progress, token) => {
            // 进度条上的取消按钮 → 作废本次索引
            token.onCancellationRequested(() => {
              this.cancelIndex();
            });

            let lastPercent = 0;

            // 阶段 1：符号索引 — 占 0%–50%
            await this.indexer.indexWorkspace((done, total, currentFile) => {
              if (this.isIndexStale(gen)) { return; }
              const percent = total > 0 ? Math.floor((done / total) * 50) : 0;
              const increment = percent - lastPercent;
              lastPercent = percent;
              progress.report({
                increment,
                message: `符号：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
              });
            }, () => this.isIndexStale(gen) || cts.token.isCancellationRequested);

            if (this.isIndexStale(gen) || cts.token.isCancellationRequested) { return; }

            // 阶段 2：倒排索引 — 占 50%–100%
            progress.report({ message: '正在构建倒排索引...' });
            const rgPath = await this._findRipgrep();
            if (this.isIndexStale(gen) || cts.token.isCancellationRequested) { return; }

            const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
            if (rgPath && wsRoot) {
              let lastPercent2 = lastPercent;
              await this.indexer.buildWordIndex(rgPath, wsRoot, (done, total, currentFile) => {
                if (this.isIndexStale(gen)) { return; }
                const percent = total > 0 ? 50 + Math.floor((done / total) * 50) : lastPercent2;
                const increment = percent - lastPercent2;
                lastPercent2 = percent;
                progress.report({
                  increment,
                  message: `倒排索引：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
                });
              }, () => this.isIndexStale(gen) || cts.token.isCancellationRequested);
            }

            if (this.isIndexStale(gen) || cts.token.isCancellationRequested) { return; }

            this.db.setLastIndexedTime(Date.now());
            await this._saveToDisk();
          });
          this._progressItem.hide();
        } catch (err: any) {
          console.error('[DB] Indexing failed', err);
          this._progressItem.text = `$(error) 索引失败`;
          setTimeout(() => this._progressItem.hide(), 5000);
        } finally {
          this._indexing = false;
          if (this._activeProgressCancel === cts) {
            this._activeProgressCancel = null;
          }
          cts.dispose();
        }
      })();
    }

    // VS Code 内保存文件时更新
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (/\.(c|h|cpp|hpp|cc|cxx|hxx)$/.test(doc.fileName)) {
        await this.indexer.indexFile(doc.uri);
        this.db.setLastIndexedTime(Date.now());
        await this._saveToDisk();
      }
    });

    // ── 外部修改文件时自动增量索引（防抖 3 秒） ──
    let externalIndexTimer: NodeJS.Timeout | undefined;
    const watcher = vscode.workspace.createFileSystemWatcher(
      '**/*.{c,h,cpp,hpp,cc,cxx,hxx}'
    );

    const scheduleExternalIndex = () => {
      if (externalIndexTimer) { clearTimeout(externalIndexTimer); }
      externalIndexTimer = setTimeout(async () => {
        try {
          const count = await this.reindexChanged();
          if (count > 0) {
            console.log(`[DB] 外部修改自动增量索引：更新了 ${count} 个文件`);
          }
        } catch (e) {
          console.warn('[DB] 外部修改自动索引失败', e);
        }
      }, 3000);
    };

    watcher.onDidChange(scheduleExternalIndex);
    watcher.onDidCreate(scheduleExternalIndex);
    watcher.onDidDelete(scheduleExternalIndex);

    this.context.subscriptions.push(watcher);
  }

  /** 全量重建索引 */
  async reindexAll(): Promise<void> {
    const gen = this.beginIndex();
    this._indexing = true;
    const cts = new vscode.CancellationTokenSource();
    this._activeProgressCancel = cts;
    try {
      this.db.clear();
      this.db.clearWordIndex();
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Peek and Map：全量重建索引',
        cancellable: true,
      }, async (progress, token) => {
        token.onCancellationRequested(() => {
          this.cancelIndex();
        });

        let lastPercent = 0;

        // 阶段 1：符号索引 — 占 0%–50%
        await this.indexer.indexWorkspace((done, total, currentFile) => {
          if (this.isIndexStale(gen)) { return; }
          const percent = total > 0 ? Math.floor((done / total) * 50) : 0;
          const increment = percent - lastPercent;
          lastPercent = percent;
          progress.report({
            increment,
            message: `符号：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
          });
        }, () => this.isIndexStale(gen) || cts.token.isCancellationRequested);

        if (this.isIndexStale(gen) || cts.token.isCancellationRequested) { return; }

        // 阶段 2：倒排索引 — 占 50%–100%
        progress.report({ message: '正在构建倒排索引...' });
        const rgPath = await this._findRipgrep();
        if (this.isIndexStale(gen) || cts.token.isCancellationRequested) { return; }

        const wsRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
        if (rgPath && wsRoot) {
          let lastPercent2 = lastPercent;
          await this.indexer.buildWordIndex(rgPath, wsRoot, (done, total, currentFile) => {
            if (this.isIndexStale(gen)) { return; }
            const percent = total > 0 ? 50 + Math.floor((done / total) * 50) : lastPercent2;
            const increment = percent - lastPercent2;
            lastPercent2 = percent;
            progress.report({
              increment,
              message: `倒排索引：${done}/${total} (${Math.floor((done / total) * 100)}%)`,
            });
          }, () => this.isIndexStale(gen) || cts.token.isCancellationRequested);
        }

        if (this.isIndexStale(gen) || cts.token.isCancellationRequested) { return; }

        this.db.setLastIndexedTime(Date.now());
        await this._saveToDisk();
      });
    } finally {
      this._indexing = false;
      if (this._activeProgressCancel === cts) {
        this._activeProgressCancel = null;
      }
      cts.dispose();
    }
  }

  /** 增量索引：只重新索引修改过的文件，返回更新的文件数 */
  async reindexChanged(): Promise<number> {
    if (this._reindexing) { return 0; }
    this._reindexing = true;
    const gen = this.beginIndex();
    this._indexing = true;
    const cts = new vscode.CancellationTokenSource();
    this._activeProgressCancel = cts;
    try {
      const since = this.db.getLastIndexedTime();
      let count = 0;
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Peek and Map：增量索引',
        cancellable: true,
      }, async (progress, token) => {
        token.onCancellationRequested(() => {
          this.cancelIndex();
        });

        let lastPercent = 0;
        count = await this.indexer.indexChangedFiles(since, (done, total, currentFile) => {
          if (this.isIndexStale(gen)) { return; }
          const percent = total > 0 ? Math.floor((done / total) * 100) : 0;
          const increment = percent - lastPercent;
          lastPercent = percent;
          progress.report({
            increment,
            message: `${done}/${total} (${percent}%)`,
          });
        }, () => this.isIndexStale(gen) || cts.token.isCancellationRequested);

        if (this.isIndexStale(gen) || cts.token.isCancellationRequested) { return; }

        this.db.setLastIndexedTime(Date.now());
        await this._saveToDisk();
      });
      return count;
    } finally {
      this._reindexing = false;
      this._indexing = false;
      if (this._activeProgressCancel === cts) {
        this._activeProgressCancel = null;
      }
      cts.dispose();
    }
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
