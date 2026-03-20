import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { DaemonConfig } from "./types.js";
import type { Logger } from "./logger.js";

export class ProcessManager extends EventEmitter {
  private child: ChildProcess | null = null;
  private retryCount = 0;
  private shuttingDown = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private uptimeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private config: DaemonConfig,
    private logger: Logger,
  ) {
    super();
  }

  isRunning(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.isRunning()) {
      this.logger.warn("Process already running");
      return;
    }
    this.shuttingDown = false;
    this.spawnChild();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.uptimeTimer) {
      clearTimeout(this.uptimeTimer);
      this.uptimeTimer = null;
    }
    if (!this.child) return;

    return new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        this.child?.kill("SIGKILL");
      }, 5000);

      this.child!.once("exit", () => {
        clearTimeout(forceKillTimer);
        this.child = null;
        resolve();
      });

      this.child!.kill("SIGTERM");
    });
  }

  sendInput(text: string): void {
    if (!this.child?.stdin?.writable) {
      this.logger.warn("Cannot send input: process not running or stdin closed");
      return;
    }
    this.child.stdin.write(text + "\n");
  }

  private spawnChild(): void {
    const args = ["--channels", this.config.channel_plugin, "--yes"];
    this.logger.info({ args }, "Spawning claude process");

    this.child = spawn("claude", args, {
      cwd: this.config.working_directory,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.emit("stdout", text);
      this.logger.debug({ stdout: text.trim() }, "claude stdout");
    });

    this.child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      this.emit("stderr", text);
      this.logger.debug({ stderr: text.trim() }, "claude stderr");
    });

    this.child.on("error", (err) => {
      this.logger.error({ err }, "Failed to spawn claude process");
      this.emit("error", err);
      this.scheduleRestart();
    });

    this.child.on("exit", (code, signal) => {
      this.logger.info({ code, signal }, "claude process exited");
      this.child = null;
      this.emit("exited", { code, signal });

      if (!this.shuttingDown) {
        this.scheduleRestart();
      }
    });

    this.uptimeTimer = setTimeout(() => {
      this.retryCount = 0;
      this.logger.info("Uptime threshold reached, retry counter reset");
    }, this.config.restart_policy.reset_after * 1000);

    this.emit("started");
  }

  private scheduleRestart(): void {
    if (this.shuttingDown) return;
    if (this.retryCount >= this.config.restart_policy.max_retries) {
      this.logger.error("Max retries reached, giving up");
      this.emit("max_retries_reached");
      return;
    }

    const delay = this.getBackoffDelay(this.retryCount);
    this.retryCount++;
    this.logger.info({ delay, retryCount: this.retryCount }, "Scheduling restart");

    this.restartTimer = setTimeout(() => {
      this.spawnChild();
    }, delay);
  }

  private getBackoffDelay(attempt: number): number {
    const base = 1000;
    const max = 60000;
    if (this.config.restart_policy.backoff === "exponential") {
      return Math.min(base * Math.pow(2, attempt), max);
    }
    return Math.min(base * (attempt + 1), max);
  }
}
