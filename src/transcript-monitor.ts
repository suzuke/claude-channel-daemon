import { EventEmitter } from "node:events";
import { open, stat } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "./logger.js";

export class TranscriptMonitor extends EventEmitter {
  private fd: number | null = null;
  private byteOffset: number = 0;
  private transcriptPath: string | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private offsetFile: string;

  constructor(private instanceDir: string, private logger: Logger) {
    super();
    this.offsetFile = join(instanceDir, "transcript-offset");
    this.loadOffset();
  }

  private loadOffset(): void {
    try {
      if (existsSync(this.offsetFile)) {
        const data = JSON.parse(readFileSync(this.offsetFile, "utf-8"));
        this.byteOffset = data.offset ?? 0;
        this.transcriptPath = data.path ?? null;
      }
    } catch {
      // Start fresh if corrupt
    }
  }

  private saveOffset(): void {
    try {
      writeFileSync(this.offsetFile, JSON.stringify({
        offset: this.byteOffset,
        path: this.transcriptPath,
      }));
    } catch {
      // Non-critical — will re-read some entries on restart
    }
  }

  async resolveTranscriptPath(): Promise<string | null> {
    const statusFile = join(this.instanceDir, "statusline.json");
    if (existsSync(statusFile)) {
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        if (data.transcript_path) return data.transcript_path;
      } catch {
        // Status file may be partially written — retry on next poll
      }
    }
    return null;
  }

  async pollIncrement(): Promise<void> {
    if (!this.transcriptPath) {
      this.transcriptPath = await this.resolveTranscriptPath();
      if (!this.transcriptPath) return;
      // If we have a saved offset for a different path, reset
      // If no saved offset, skip to end (first run)
      if (this.byteOffset === 0) {
        try {
          const initial = await stat(this.transcriptPath);
          this.byteOffset = initial.size;
          this.saveOffset();
          return;
        } catch { return; }
      }
    }
    if (!existsSync(this.transcriptPath)) return;

    try {
      const stats = await stat(this.transcriptPath);
      if (stats.size <= this.byteOffset) return;

      const fh = await open(this.transcriptPath, "r");
      try {
        const length = stats.size - this.byteOffset;
        const buffer = Buffer.alloc(length);
        await fh.read(buffer, 0, length, this.byteOffset);
        this.byteOffset = stats.size;

        const text = buffer.toString("utf-8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            this.processEntry(entry);
          } catch {
            // Malformed JSONL line in transcript — skip
          }
        }

        this.saveOffset();
      } finally {
        await fh.close();
      }
    } catch (err) {
      this.logger.debug({ err }, "TranscriptMonitor poll error");
    }
  }

  private processEntry(entry: any): void {
    const msg = entry.message;
    if (!msg?.role || !msg?.content) return;

    const contents = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];

    for (const block of contents) {
      if (block.type === "tool_use") {
        this.emit("tool_use", block.name ?? "unknown", block.input ?? {});
      } else if (block.type === "tool_result") {
        this.emit("tool_result", block.tool_use_id ?? "unknown", block.content);
      } else if (block.type === "text" && msg.role === "assistant" && block.text?.trim()) {
        const channelMatch = block.text.match(/<channel[^>]*user="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/);
        if (channelMatch) {
          this.emit("channel_message", channelMatch[1], channelMatch[2]);
        } else {
          this.emit("assistant_text", block.text);
        }
      }
    }
  }

  startPolling(intervalMs = 2000): void {
    this.pollTimer = setInterval(() => this.pollIncrement(), intervalMs);
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.saveOffset();
  }

  setTranscriptPath(path: string): void {
    if (this.transcriptPath !== path) {
      this.resetOffset();
    }
    this.transcriptPath = path;
  }

  resetOffset(): void {
    this.byteOffset = 0;
    this.transcriptPath = null;
    this.saveOffset();
  }
}
