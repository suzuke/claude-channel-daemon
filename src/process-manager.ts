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
  private suppressSessionCapture = false;

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
    this.suppressSessionCapture = false;
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

  /** Clear saved session ID so next start creates a fresh session. */
  clearSessionId(): void {
    this.sessionId = null;
    this.suppressSessionCapture = true;
    this.saveSessionId();
    this.logger.info("Session ID cleared — next start will create a fresh session");
  }

  sendInput(text: string): void {
    if (!this.term || !this.running) {
      this.logger.warn("Cannot send input: process not running");
      return;
    }
    this.term.write(text + "\r");
  }

  private ensureStatusLineScript(): void {
    // Tee stdin JSON to our file, then pipe to the user's original statusLine command.
    const script = `#!/bin/bash
INPUT=$(cat)
echo "$INPUT" > "${STATUSLINE_FILE}"
if command -v ccline &>/dev/null; then
  echo "$INPUT" | ccline
else
  echo "ok"
fi
`;
    writeFileSync(STATUSLINE_SCRIPT, script, { mode: 0o755 });

    // Write a settings file (not CLI flag) so it doesn't conflict with
    // other --settings injected by tools like cmux
    const settingsFile = join(DATA_DIR, "claude-settings.json");
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: "curl -s -X POST http://127.0.0.1:18321/approve -H 'Content-Type: application/json' -d @- --max-time 130 --connect-timeout 1",
                timeout: 135000,
              },
            ],
          },
        ],
      },
      permissions: {
        allow: [
          "Read", "Edit", "Write", "Glob", "Grep",
          "Bash(*)", "WebFetch", "WebSearch", "Agent", "Skill",
          "mcp__plugin_telegram_telegram__reply",
          "mcp__plugin_telegram_telegram__react",
          "mcp__plugin_telegram_telegram__edit_message",
        ],
        deny: [
          "Bash(rm -rf /)", "Bash(rm -rf /*)",
          "Bash(rm -rf ~)", "Bash(rm -rf ~/*)",
          "Bash(git push * --force *)", "Bash(git push --force *)",
          "Bash(git reset --hard *)", "Bash(git clean -fd *)",
          "Bash(git clean -f *)", "Bash(dd *)", "Bash(mkfs *)",
        ],
        defaultMode: "default",
      },
      statusLine: {
        type: "command",
        command: STATUSLINE_SCRIPT,
      },
    };
    writeFileSync(settingsFile, JSON.stringify(settings));
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

    // Auto-approve edits to prevent hanging on protected paths (.claude/skills/ etc.)
    args.push("--permission-mode", "acceptEdits");

    // Settings file has: permissions, PreToolUse hook (→ Telegram approval), statusLine
    const settingsFile = join(DATA_DIR, "claude-settings.json");
    args.push("--settings", settingsFile);

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
      if (resumeMatch && !this.suppressSessionCapture) {
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
