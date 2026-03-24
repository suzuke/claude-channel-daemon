import { EventEmitter } from "node:events";
import { readFileSync, watchFile, unwatchFile, existsSync } from "node:fs";
import type { ContextStatus, StatusLineData, DaemonConfig } from "./types.js";
import type { Logger } from "./logger.js";

type GuardianConfig = DaemonConfig["context_guardian"];
type State = "NORMAL" | "PENDING" | "HANDING_OVER" | "ROTATING" | "GRACE";
export type RotationReason = "context_full" | "max_age";

export class ContextGuardian extends EventEmitter {
  state: State = "NORMAL";
  rotationReason: RotationReason | null = null;
  private ageTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private statusFilePath: string;
  private consecutiveReadFailures = 0;

  constructor(
    private config: GuardianConfig,
    private logger: Logger,
    statusFilePath: string,
  ) {
    super();
    this.statusFilePath = statusFilePath;
  }

  startWatching(): void {
    this.logger.debug({ path: this.statusFilePath }, "Watching status line file");
    // watchFile (polling) over fs.watch: more reliable on NFS/Docker volumes; 2s latency is acceptable
    watchFile(this.statusFilePath, { interval: 2000 }, () => this.readAndCheck());
  }

  private readAndCheck(): void {
    try {
      if (!existsSync(this.statusFilePath)) return;
      const raw = readFileSync(this.statusFilePath, "utf-8");
      const data: StatusLineData = JSON.parse(raw);
      const cw = data.context_window;

      if (cw.used_percentage != null) {
        this.consecutiveReadFailures = 0;
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
      } else {
        this.consecutiveReadFailures++;
        if (this.consecutiveReadFailures >= 3) {
          this.logger.warn({ consecutiveFailures: this.consecutiveReadFailures }, "Context usage unavailable for 3+ consecutive reads, skipping threshold check");
        }
      }
    } catch (err) {
      this.consecutiveReadFailures++;
      if (this.consecutiveReadFailures >= 3) {
        this.logger.warn({ err, consecutiveFailures: this.consecutiveReadFailures }, "Context usage read failed 3+ consecutive times");
      } else {
        this.logger.debug({ err }, "Failed to read status line file");
      }
    }
  }

  updateContextStatus(status: ContextStatus): void {
    if (this.state !== "NORMAL") return;
    if (status.used_percentage > this.config.threshold_percentage) {
      this.logger.info(
        { used: status.used_percentage, threshold: this.config.threshold_percentage },
        "Context threshold exceeded — waiting for idle",
      );
      this.enterPending("context_full");
    }
  }

  signalIdle(): void {
    if (this.state !== "PENDING") return;
    this.enterHandingOver();
  }

  signalHandoverComplete(): void {
    if (this.state !== "HANDING_OVER") return;
    this.clearTimer("completionTimer");
    this.enterRotating();
  }

  markRotationComplete(): void {
    if (this.state !== "ROTATING") return;
    this.enterGrace();
  }

  startTimer(): void {
    if (this.ageTimer) return;
    const ms = this.config.max_age_hours * 60 * 60 * 1000;
    this.ageTimer = setTimeout(() => {
      this.logger.info("Max age reached — waiting for idle");
      if (this.state === "NORMAL") this.enterPending("max_age");
    }, ms);
  }

  private resetAgeTimer(): void {
    if (this.ageTimer) {
      clearTimeout(this.ageTimer);
      this.ageTimer = null;
    }
    this.startTimer();
  }

  // No removeAllListeners — external listeners are on daemon, which is GC'd together with this instance
  stop(): void {
    this.clearTimer("ageTimer");
    this.clearTimer("idleTimer");
    this.clearTimer("completionTimer");
    this.clearTimer("graceTimer");
    unwatchFile(this.statusFilePath);
  }

  private enterPending(reason: RotationReason): void {
    this.state = "PENDING";
    this.rotationReason = reason;
    this.emit("pending");
    this.idleTimer = setTimeout(() => {
      this.logger.warn("Idle wait timeout — abandoning this rotation attempt");
      this.state = "NORMAL";
      this.rotationReason = null;
    }, this.config.max_idle_wait_ms);
  }

  private enterHandingOver(): void {
    this.clearTimer("idleTimer");
    this.state = "HANDING_OVER";
    this.emit("request_handover");
    this.completionTimer = setTimeout(() => {
      this.logger.warn("Handover completion timeout — proceeding to rotate");
      this.enterRotating();
    }, this.config.completion_timeout_ms);
  }

  private enterRotating(): void {
    this.state = "ROTATING";
    this.emit("rotate");
  }

  private enterGrace(): void {
    this.state = "GRACE";
    this.graceTimer = setTimeout(() => {
      this.state = "NORMAL";
      this.rotationReason = null;
      this.resetAgeTimer();
    }, this.config.grace_period_ms);
  }

  private clearTimer(name: "ageTimer" | "idleTimer" | "completionTimer" | "graceTimer"): void {
    if (this[name]) {
      clearTimeout(this[name]);
      this[name] = null;
    }
  }
}
