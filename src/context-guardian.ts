import { EventEmitter } from "node:events";
import type { ContextStatus, DaemonConfig } from "./types.js";
import type { Logger } from "./logger.js";

type GuardianConfig = DaemonConfig["context_guardian"];

export class ContextGuardian extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rotating = false;

  constructor(
    private config: GuardianConfig,
    private logger: Logger,
  ) {
    super();
  }

  updateContextStatus(status: ContextStatus): void {
    this.logger.debug({ status }, "Context status update");
    if (status.used_percentage > this.config.threshold_percentage && !this.rotating) {
      this.logger.info(
        { used: status.used_percentage, threshold: this.config.threshold_percentage },
        "Context threshold exceeded, triggering rotation",
      );
      this.triggerRotation("threshold");
    }
  }

  parseStatusLine(line: string): ContextStatus | null {
    // Try JSON format first (status line script output)
    try {
      const parsed = JSON.parse(line);
      if (parsed?.context_window) {
        return parsed.context_window as ContextStatus;
      }
    } catch {}

    // Parse TUI status bar format: "15.1% · 151.5k tokens"
    const pctMatch = line.match(/(\d+(?:\.\d+)?)%\s*·\s*([\d.]+)k?\s*tokens/);
    if (pctMatch) {
      const used = parseFloat(pctMatch[1]);
      return {
        used_percentage: used,
        remaining_percentage: 100 - used,
        context_window_size: 200000, // default assumption
      };
    }

    return null;
  }

  startTimer(): void {
    if (this.timer) return;
    const ms = this.config.max_age_hours * 60 * 60 * 1000;
    this.timer = setTimeout(() => {
      this.logger.info("Max age reached, triggering timer rotation");
      this.triggerRotation("timer");
    }, ms);
  }

  resetTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.startTimer();
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  markRotationComplete(): void {
    this.rotating = false;
    this.resetTimer();
  }

  private triggerRotation(reason: "threshold" | "timer"): void {
    this.rotating = true;
    this.emit("rotate", reason);
  }
}
