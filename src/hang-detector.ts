import { EventEmitter } from "node:events";

export class HangDetector extends EventEmitter {
  private lastActivityTs = 0;
  private lastStatuslineTs = 0;
  private hungEmitted = false;
  private checkTimer: ReturnType<typeof setInterval> | null = null;
  private timeoutMs: number;

  constructor(timeoutMinutes: number) {
    super();
    this.timeoutMs = timeoutMinutes * 60 * 1000;
  }

  recordActivity(): void {
    this.lastActivityTs = Date.now();
    if (this.hungEmitted) {
      this.hungEmitted = false;
    }
  }

  recordStatuslineUpdate(): void {
    this.lastStatuslineTs = Date.now();
  }

  isHung(): boolean {
    if (this.lastActivityTs === 0) return false;
    const now = Date.now();
    const transcriptStale = now - this.lastActivityTs > this.timeoutMs;
    const statuslineStale = this.lastStatuslineTs === 0 || now - this.lastStatuslineTs > this.timeoutMs;
    return transcriptStale && statuslineStale;
  }

  start(intervalMs = 60_000): void {
    this.checkTimer = setInterval(() => {
      if (this.isHung() && !this.hungEmitted) {
        this.hungEmitted = true;
        this.emit("hang");
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }
}
