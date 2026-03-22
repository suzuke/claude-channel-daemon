import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "chokidar";
import { readFileSync } from "node:fs";
import type { MemoryDb } from "./db.js";
import type { Logger } from "./logger.js";

export class MemoryLayer extends EventEmitter {
  private watcher: FSWatcher | null = null;

  constructor(
    private memoryDir: string,
    private db: MemoryDb,
    private logger: Logger,
  ) {
    super();
  }

  async start(): Promise<void> {
    this.logger.info({ dir: this.memoryDir }, "Watching memory directory");

    this.watcher = watch(this.memoryDir, {
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 200 },
    });

    this.watcher.on("add", (path) => this.backupFile(path));
    this.watcher.on("change", (path) => this.backupFile(path));
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
  }

  private backupFile(filePath: string): void {
    try {
      const content = readFileSync(filePath, "utf-8");
      this.db.insertBackup(filePath, content, null);
      this.logger.info({ filePath }, "Memory file backed up");
      this.emit("file_changed", filePath);
    } catch (err) {
      this.logger.error({ err, filePath }, "Failed to backup memory file");
    }
  }
}
