import { EventEmitter } from "node:events";
import { readFileSync, watchFile, unwatchFile, existsSync } from "node:fs";
import type { ContextStatus, StatusLineData, DaemonConfig } from "./types.js";
import type { Logger } from "./logger.js";

type GuardianConfig = DaemonConfig["context_guardian"];

export class ContextGuardian extends EventEmitter {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private rotating = false;
  private statusFilePath: string;

  constructor(
    private config: GuardianConfig,
    private logger: Logger,
    statusFilePath: string,
  ) {
    super();
    this.statusFilePath = statusFilePath;
  }

  /** Start watching the status line JSON file for updates. */
  startWatching(): void {
    this.logger.info({ path: this.statusFilePath }, "Watching status line file");
    watchFile(this.statusFilePath, { interval: 2000 }, () => {
      this.readAndCheck();
    });
  }

  /** Read the status line JSON file and check context usage. */
  private readAndCheck(): void {
    try {
      if (!existsSync(this.statusFilePath)) return;
      const raw = readFileSync(this.statusFilePath, "utf-8");
      const data: StatusLineData = JSON.parse(raw);
      const cw = data.context_window;

      if (cw.used_percentage != null) {
        const status: ContextStatus = {
          used_percentage: cw.used_percentage,
          remaining_percentage: cw.remaining_percentage ?? (100 - cw.used_percentage),
          context_window_size: cw.context_window_size,
        };
        const rl = data.rate_limits;
        this.logger.debug({
          context: `${cw.used_percentage}%`,
          cost: `$${data.cost.total_cost_usd.toFixed(2)}`,
          rate_5h: rl?.five_hour ? `${rl.five_hour.used_percentage}%` : "n/a",
          rate_7d: rl?.seven_day ? `${rl.seven_day.used_percentage}%` : "n/a",
        }, "Status update received");
        this.emit("status_update", { ...status, rate_limits: rl });
        this.updateContextStatus(status);
      }
    } catch (err) {
      this.logger.debug({ err }, "Failed to read status line file");
    }
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
    unwatchFile(this.statusFilePath);
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
