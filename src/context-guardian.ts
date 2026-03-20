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
    try {
      const parsed = JSON.parse(line);
      if (parsed?.context_window) {
        return parsed.context_window as ContextStatus;
      }
      return null;
    } catch {
      return null;
    }
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
