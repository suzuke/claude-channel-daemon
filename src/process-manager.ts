import pty, { type IPty } from "node-pty";
import { EventEmitter } from "node:events";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import stripAnsi from "strip-ansi";
import type { DaemonConfig } from "./types.js";
import type { Logger } from "./logger.js";

const DATA_DIR = join(homedir(), ".claude-channel-daemon");
const SESSION_FILE = join(DATA_DIR, "session-id");
export const STATUSLINE_FILE = join(DATA_DIR, "statusline.json");
const STATUSLINE_SCRIPT = join(DATA_DIR, "statusline.sh");

export class ProcessManager extends EventEmitter {
  private term: IPty | null = null;
  private running = false;
  private retryCount = 0;
  private shuttingDown = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private uptimeTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string | null = null;

  constructor(
    private config: DaemonConfig,
    private logger: Logger,
  ) {
    super();
    this.loadSessionId();
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn("Process already running");
      return;
    }
    this.shuttingDown = false;
    this.ensureSpawnHelper();
    this.ensureStatusLineScript();
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
    if (!this.term) return;

    // Send /exit to claude for graceful shutdown
    this.term.write("/exit\r");

    return new Promise((resolve) => {
      const forceKillTimer = setTimeout(() => {
        try { this.term?.kill(); } catch {}
      }, 5000);

      this.term!.onExit(() => {
        clearTimeout(forceKillTimer);
        this.term = null;
        this.running = false;
        resolve();
      });
    });
  }

  sendInput(text: string): void {
    if (!this.term || !this.running) {
      this.logger.warn("Cannot send input: process not running");
      return;
    }
    this.term.write(text + "\r");
  }

  private ensureStatusLineScript(): void {
    const script = `#!/bin/bash\ncat > "${STATUSLINE_FILE}"\necho "ok"\n`;
    writeFileSync(STATUSLINE_SCRIPT, script, { mode: 0o755 });
  }

  private ensureSpawnHelper(): void {
    // node-pty's spawn-helper loses +x after npm install on macOS
    try {
      const helperPath = join(
        process.cwd(),
        "node_modules/node-pty/prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper",
      );
      if (existsSync(helperPath)) {
        execFileSync("chmod", ["+x", helperPath]);
      }
    } catch {
      // Best effort — may not be needed on all platforms
    }
  }

  private resolveClaudeBin(): string {
    try {
      return execSync("which claude", { encoding: "utf8" }).trim();
    } catch {
      return "claude";
    }
  }

  private spawnChild(): void {
    const claudeBin = this.resolveClaudeBin();
    const args: string[] = [];

    // Channel mode: route Telegram messages as user prompts
    args.push("--channels", `plugin:${this.config.channel_plugin}`);

    // Inject status line script via --settings
    const settings = {
      statusLine: {
        type: "command",
        command: STATUSLINE_SCRIPT,
      },
    };
    args.push("--settings", JSON.stringify(settings));

    // Resume previous session if available
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
      this.logger.info({ sessionId: this.sessionId }, "Resuming previous session");
    }

    this.logger.info({ claudeBin, args: args.map(a => a.length > 50 ? a.slice(0, 50) + "..." : a), cwd: this.config.working_directory }, "Spawning claude via PTY");

    this.term = pty.spawn(claudeBin, args, {
      name: "xterm-256color",
      cols: 220,
      rows: 50,
      cwd: this.config.working_directory,
      env: {
        ...process.env,
        TERM: "xterm-256color",
      },
    });

    this.running = true;

    this.term.onData((data) => {
      const clean = stripAnsi(data);
      if (clean.trim()) {
        this.emit("stdout", clean);
        this.logger.debug({ stdout: clean.trim().slice(0, 200) }, "claude stdout");
      }

      // Capture session ID from output (claude prints: claude --resume <uuid>)
      const resumeMatch = clean.match(/--resume\s+([0-9a-f-]{36})/);
      if (resumeMatch) {
        this.sessionId = resumeMatch[1];
        this.saveSessionId();
        this.logger.info({ sessionId: this.sessionId }, "Captured session ID for resume");
      }
    });

    this.term.onExit(({ exitCode, signal }) => {
      this.logger.info({ exitCode, signal }, "claude process exited");
      this.term = null;
      this.running = false;
      this.emit("exited", { code: exitCode, signal });

      if (!this.shuttingDown) {
        this.scheduleRestart();
      }
    });

    // Reset retry counter after stable uptime
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

  private loadSessionId(): void {
    try {
      if (existsSync(SESSION_FILE)) {
        this.sessionId = readFileSync(SESSION_FILE, "utf-8").trim();
        if (this.sessionId) {
          this.logger.info({ sessionId: this.sessionId }, "Loaded previous session ID");
        }
      }
    } catch {}
  }

  private saveSessionId(): void {
    try {
      writeFileSync(SESSION_FILE, this.sessionId ?? "");
    } catch {}
  }
}
