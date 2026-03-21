#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { ProcessManager, STATUSLINE_FILE } from "./process-manager.js";
import { ContextGuardian } from "./context-guardian.js";
import { MemoryLayer } from "./memory-layer.js";
import { MemoryDb } from "./db.js";
import {
  installService,
  uninstallService,
  detectPlatform,
} from "./service-installer.js";
import { join } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

const DATA_DIR = join(homedir(), ".claude-channel-daemon");
const DEFAULT_CONFIG_PATH = join(DATA_DIR, "config.yaml");
const DB_PATH = join(DATA_DIR, "memory.db");
const PID_PATH = join(DATA_DIR, "daemon.pid");
const LOG_PATH = join(DATA_DIR, "daemon.log");

const program = new Command();

program
  .name("claude-channel-daemon")
  .description("Reliable daemon wrapper for Claude Code Channels")
  .version("0.1.0");

program
  .command("start")
  .description("Start the daemon")
  .option("-c, --config <path>", "Config file path", DEFAULT_CONFIG_PATH)
  .action(async (opts) => {
    mkdirSync(DATA_DIR, { recursive: true });
    const config = loadConfig(opts.config);
    const logger = createLogger(config.log_level);

    // Write PID file
    writeFileSync(PID_PATH, String(process.pid));
    logger.info({ pid: process.pid }, "Starting claude-channel-daemon");

    const pm = new ProcessManager(config, logger);
    const guardian = new ContextGuardian(config.context_guardian, logger, STATUSLINE_FILE);

    let memoryLayer: MemoryLayer | null = null;
    if (config.memory.watch_memory_dir || config.memory.backup_to_sqlite) {
      const db = new MemoryDb(DB_PATH);
      // Memory dir is configurable; fall back to Claude Code's convention
      const memoryDir = config.memory_directory
        ?? join(
          homedir(),
          ".claude/projects",
          config.working_directory.replace(/\//g, "-").replace(/^-/, ""),
          "memory",
        );
      if (existsSync(memoryDir)) {
        memoryLayer = new MemoryLayer(memoryDir, db, logger);
        await memoryLayer.start();
      } else {
        logger.warn({ memoryDir }, "Memory directory not found, skipping memory layer");
      }
    }

    // Tail-follow the transcript file for real-time activity logging
    let transcriptOffset = -1; // -1 = not initialized, skip existing content on first read
    let transcriptPath: string | null = null;

    function pollTranscript() {
      try {
        if (!transcriptPath) {
          // Try statusline first
          try {
            const statusData = JSON.parse(readFileSync(STATUSLINE_FILE, "utf-8"));
            transcriptPath = statusData.transcript_path ?? null;
          } catch {}
          // Fallback: find most recent jsonl in the project directory
          if (!transcriptPath) {
            const projectDir = join(
              homedir(),
              ".claude/projects",
              config.working_directory.replace(/\//g, "-").replace(/^-/, ""),
            );
            if (existsSync(projectDir)) {
              try {
                const files = readdirSync(projectDir)
                  .filter(f => f.endsWith(".jsonl"))
                  .map(f => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
                  .sort((a, b) => b.mtime - a.mtime);
                if (files.length > 0) {
                  transcriptPath = join(projectDir, files[0].name);
                }
              } catch {}
            }
          }
          if (!transcriptPath) return;
        }
        if (!existsSync(transcriptPath)) return;
        const content = readFileSync(transcriptPath, "utf-8");

        // On first read, skip to end (don't replay history)
        if (transcriptOffset === -1) {
          transcriptOffset = content.length;
          logger.info("Transcript found, tailing for new activity");
          return;
        }

        if (content.length <= transcriptOffset) return;

        const newContent = content.slice(transcriptOffset);
        transcriptOffset = content.length;

        for (const line of newContent.trim().split("\n")) {
          try {
            const entry = JSON.parse(line);
            const msg = entry.message;
            if (!msg?.role || !msg?.content) continue;

            const contents = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];

            for (const block of contents) {
              if (block.type === "text" && block.text?.trim()) {
                const channelMatch = block.text.match(/<channel[^>]*user="([^"]*)"[^>]*>\n?([\s\S]*?)\n?<\/channel>/);
                if (channelMatch) {
                  logger.info({ from: channelMatch[1], text: channelMatch[2].slice(0, 200) }, "📩 Telegram");
                } else if (msg.role === "assistant") {
                  logger.info({ text: block.text.slice(0, 300) }, "💬 Claude");
                }
              } else if (block.type === "tool_use") {
                const name = block.name ?? "unknown";
                const input = block.input ?? {};
                // Summarize tool use
                if (name.includes("reply")) {
                  logger.info({ to: input.chat_id, text: String(input.text ?? "").slice(0, 200) }, "📤 Telegram reply");
                } else if (name === "Read") {
                  logger.info({ file: input.file_path }, "📖 Read");
                } else if (name === "Edit") {
                  logger.info({ file: input.file_path }, "✏️ Edit");
                } else if (name === "Write") {
                  logger.info({ file: input.file_path }, "📝 Write");
                } else if (name === "Bash") {
                  logger.info({ cmd: String(input.command ?? "").slice(0, 100) }, "🖥️ Bash");
                } else {
                  logger.info({ tool: name }, "🔧 Tool");
                }
              }
            }
          } catch {}
        }
      } catch {}
    }

    // Poll transcript every 2 seconds
    const transcriptInterval = setInterval(pollTranscript, 2000);

    // Handle PTY permission prompts that aren't auto-approved
    pm.on("permission_prompt", async (promptText: string) => {
      // Send to Telegram via direct bot API (approval server handles inline buttons)
      try {
        const envFile = join(homedir(), ".claude/channels/telegram/.env");
        const envContent = readFileSync(envFile, "utf-8");
        const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=(.+)/);
        const accessFile = join(homedir(), ".claude/channels/telegram/access.json");
        const access = JSON.parse(readFileSync(accessFile, "utf-8"));
        const chatId = access.allowFrom?.[0];

        if (tokenMatch && chatId) {
          const token = tokenMatch[1].trim();
          const text = `⚠️ PTY 權限請求:\n${promptText.slice(0, 500)}\n\n回覆 1 批准, 3 拒絕`;
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ 批准", callback_data: "pty_approve" },
                  { text: "❌ 拒絕", callback_data: "pty_deny" },
                ]],
              },
            }),
          });
          logger.info("Permission prompt forwarded to Telegram, waiting for response...");

          // Wait for user response via transcript (callback comes as channel message)
          const maxWait = 120000;
          const poll = 2000;
          let elapsed = 0;
          const waitInterval = setInterval(() => {
            elapsed += poll;
            try {
              if (transcriptPath && existsSync(transcriptPath)) {
                const content = readFileSync(transcriptPath, "utf-8");
                const tail = content.slice(-500);
                if (tail.includes("pty_approve")) {
                  clearInterval(waitInterval);
                  logger.info("User approved via Telegram");
                  pm.sendInput("1");
                } else if (tail.includes("pty_deny")) {
                  clearInterval(waitInterval);
                  logger.info("User denied via Telegram");
                  pm.sendInput("3");
                }
              }
            } catch {}
            if (elapsed >= maxWait) {
              clearInterval(waitInterval);
              logger.warn("Permission prompt timed out — auto-denying");
              pm.sendInput("3");
            }
          }, poll);
        } else {
          logger.warn("Cannot forward permission prompt — no bot token or chat ID");
          pm.sendInput("3"); // deny if can't forward
        }
      } catch (err) {
        logger.error({ err }, "Failed to forward permission prompt");
        pm.sendInput("3");
      }
    });

    // Watch status line JSON file for context updates
    guardian.startWatching();

    // Handle rotation — kill and respawn instead of /clear
    guardian.on("rotate", async (reason: string) => {
      logger.info({ reason }, "🔄 Rotation triggered — restarting session");
      // Reset transcript tracking for the new session
      transcriptPath = null;
      transcriptOffset = -1;
      // Clear session ID so we get a fresh session (not resume the old one)
      pm.clearSessionId();
      // Clear stale statusline so the new session doesn't immediately re-trigger
      try { writeFileSync(STATUSLINE_FILE, "{}"); } catch {}
      // Stop and restart
      await pm.stop();
      logger.info("Session stopped, respawning fresh session");
      await pm.start();
      guardian.markRotationComplete();
    });

    // Health check: ping approval server every 30 seconds
    const APPROVAL_URL = "http://127.0.0.1:18321/approve";
    let approvalDownSince: number | null = null;
    const healthCheckInterval = setInterval(async () => {
      try {
        const res = await fetch(APPROVAL_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool_name: "__health_check", tool_input: {} }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          if (approvalDownSince) {
            logger.info("Approval server recovered");
            approvalDownSince = null;
          }
        }
      } catch {
        if (!approvalDownSince) {
          approvalDownSince = Date.now();
          logger.warn("⚠️ Approval server unreachable — all tool calls will be denied until it recovers");
        } else if (Date.now() - approvalDownSince > 60_000) {
          logger.error("⚠️ Approval server down >60s — all tool calls are being denied");
          // Notify once, then reset timer so we don't spam
          approvalDownSince = Date.now();
        }
      }
    }, 30_000);

    guardian.startTimer();
    await pm.start();

    // Graceful shutdown
    const shutdown = async () => {
      logger.info("Shutting down...");
      clearInterval(transcriptInterval);
      clearInterval(healthCheckInterval);
      guardian.stop();
      if (memoryLayer) await memoryLayer.stop();
      await pm.stop();
      if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
      process.exit(0);
    };

    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  });

program
  .command("stop")
  .description("Stop the daemon")
  .action(() => {
    if (!existsSync(PID_PATH)) {
      console.error("Daemon is not running (no PID file found)");
      process.exit(1);
    }
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGTERM");
      unlinkSync(PID_PATH);
      console.log("Daemon stopped");
    } catch {
      console.error("Failed to stop daemon (process may have already exited)");
      if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
    }
  });

program
  .command("status")
  .description("Show daemon status")
  .action(() => {
    if (!existsSync(PID_PATH)) {
      console.log("Status: stopped");
      return;
    }
    const pid = parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      console.log(`Status: running (PID ${pid})`);
    } catch {
      console.log("Status: stopped (stale PID file)");
    }
  });

program
  .command("logs")
  .description("Show daemon logs")
  .option("-n, --lines <count>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output")
  .action(async (opts) => {
    if (!existsSync(LOG_PATH)) {
      console.error("No log file found");
      process.exit(1);
    }
    if (opts.follow) {
      const rl = createInterface({ input: createReadStream(LOG_PATH, { start: 0 }) });
      rl.on("line", (line) => console.log(line));
      process.stdin.resume();
    } else {
      const content = readFileSync(LOG_PATH, "utf-8");
      const lines = content.trim().split("\n");
      const n = parseInt(opts.lines, 10);
      console.log(lines.slice(-n).join("\n"));
    }
  });

program
  .command("install")
  .description("Install as system service")
  .action(() => {
    const execPath = process.argv[1];
    const config = loadConfig(DEFAULT_CONFIG_PATH);
    const path = installService({
      label: "com.claude-channel-daemon",
      execPath,
      workingDirectory: config.working_directory,
      logPath: LOG_PATH,
    });
    console.log(`Service installed at: ${path}`);
    const plat = detectPlatform();
    if (plat === "macos") {
      console.log(`Run: launchctl load ${path}`);
    } else {
      console.log("Run: systemctl --user enable --now claude-channel-daemon");
    }
  });

program
  .command("uninstall")
  .description("Remove system service")
  .action(() => {
    const removed = uninstallService("com.claude-channel-daemon");
    if (removed) {
      console.log("Service uninstalled");
    } else {
      console.log("No service found to uninstall");
    }
  });

program
  .command("init")
  .description("Interactive setup wizard")
  .action(async () => {
    const { runSetupWizard } = await import("./setup-wizard.js");
    await runSetupWizard();
  });

program.parse();
