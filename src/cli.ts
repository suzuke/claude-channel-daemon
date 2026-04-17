#!/usr/bin/env node
import { Command } from "commander";
import { join, dirname } from "node:path";
import { SchedulerDb } from "./scheduler/db.js";
import { Cron } from "croner";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, totalmem, freemem } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execSync, execFileSync } from "node:child_process";
import { getAgendHome, getTmuxSocketName } from "./paths.js";

/** Prefix tmux args with -L when socket isolation is active. */
function tmuxArgs(args: string[]): string[] {
  const socket = getTmuxSocketName();
  return socket ? ["-L", socket, ...args] : args;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = getAgendHome();
const FLEET_CONFIG_PATH = join(DATA_DIR, "fleet.yaml");

const program = new Command();

// Read version from package.json at build time
const pkgVersion = (() => {
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf-8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

program
  .name("agend")
  .description("AgEnD — AI Engineering Daemon")
  .version(pkgVersion);

function signalFleetReload(): void {
  const pidPath = join(DATA_DIR, "fleet.pid");
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    process.kill(pid, "SIGHUP");
    console.log("Fleet manager notified to reload config.");
  } catch {
    console.log("Fleet manager not running. Config will be loaded on next start.");
  }
}

// === Fleet commands ===
const fleet = program.command("fleet").description("Fleet management");

fleet
  .command("start")
  .description("Start fleet or specific instance")
  .argument("[instance]", "Specific instance to start")
  .action(async (instance?: string) => {
    if (instance) {
      // If fleet daemon is already running, delegate via HTTP API
      const { loadFleetConfig } = await import("./config.js");
      const fleet = loadFleetConfig(FLEET_CONFIG_PATH);
      const port = fleet.health_port ?? 19280;
      try {
        const healthResp = await fetch(`http://127.0.0.1:${port}/health`);
        if (healthResp.ok) {
          try {
            const resp = await fetch(`http://127.0.0.1:${port}/api/instance/${encodeURIComponent(instance)}/start`, { method: "POST" });
            const body = await resp.json() as Record<string, unknown>;
            if (resp.ok) {
              console.log(`Instance "${instance}" started via running fleet daemon`);
            } else {
              console.error(`Start failed: ${body.error ?? resp.statusText}`);
              process.exit(1);
            }
          } catch (err) {
            console.error(`Failed to start instance via fleet API: ${(err as Error).message}`);
            process.exit(1);
          }
          return;
        }
      } catch { /* fleet not running, fall through */ }
    }

    const { FleetManager } = await import("./fleet-manager.js");
    const fm = new FleetManager(DATA_DIR);
    if (instance) {
      const config = fm.loadConfig(FLEET_CONFIG_PATH);
      const inst = config.instances[instance];
      if (!inst) {
        console.error(`Instance "${instance}" not found in fleet config`);
        process.exit(1);
      }
      const topicMode = config.channel?.mode === "topic";
      await fm.startInstance(instance, inst, topicMode);
    } else {
      if (process.env.AGEND_HOME) {
        console.log(`  Using AGEND_HOME: ${process.env.AGEND_HOME}`);
      }
      await fm.startAll(FLEET_CONFIG_PATH);
    }
    console.log("Fleet started");

    // Keep process alive + clean shutdown on Ctrl+C
    const shutdown = async () => {
      console.log("\nStopping fleet...");
      await fm.stopAll();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    process.on("uncaughtException", async (err) => {
      console.error("Uncaught exception:", err);
      await fm.stopAll().catch(() => {});
      process.exit(1);
    });
    process.on("unhandledRejection", async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      // 409 = another bot poller exists — adapter handles retry, don't crash
      if (msg.includes("409") && msg.includes("getUpdates")) {
        console.error("Bot polling conflict (409) — retrying...");
        return;
      }
      console.error("Unhandled rejection:", err);
      await fm.stopAll().catch(() => {});
      process.exit(1);
    });
  });

fleet
  .command("stop")
  .description("Stop fleet or specific instance")
  .argument("[instance]", "Specific instance to stop")
  .action(async (instance?: string) => {
    if (instance) {
      const { FleetManager } = await import("./fleet-manager.js");
      const fm = new FleetManager(DATA_DIR);
      await fm.stopInstance(instance);
      console.log("Stopped");
    } else {
      const pidPath = join(DATA_DIR, "fleet.pid");
      if (!existsSync(pidPath)) {
        console.error("Fleet is not running (no PID file found)");
        process.exit(1);
      }
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        console.error("Failed to send SIGTERM (process may have already exited)");
        try { unlinkSync(pidPath); } catch {}
        process.exit(1);
      }
      // Wait for process exit (up to 10 seconds)
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0);
          await new Promise(r => setTimeout(r, 200));
        } catch {
          // Process exited
          console.log("Fleet stopped");
          return;
        }
      }
      console.warn("Warning: fleet process still running after 10s");
    }
  });

fleet
  .command("restart")
  .description("Graceful restart: wait for instances to idle, then restart")
  .argument("[instance]", "Specific instance to restart (immediate, no idle wait)")
  .option("--reload", "Full process restart to load new code")
  .action(async (instance?: string, opts?: { reload?: boolean }) => {
    if (instance && opts?.reload) {
      console.error("--reload restarts the entire fleet process. Cannot combine with instance name.");
      process.exit(1);
    }

    if (instance) {
      // Single instance restart via fleet's HTTP API
      const { loadFleetConfig } = await import("./config.js");
      const fleet = loadFleetConfig(FLEET_CONFIG_PATH);
      const port = fleet.health_port ?? 19280;
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/restart/${encodeURIComponent(instance)}`, { method: "POST" });
        const body = await resp.json() as Record<string, unknown>;
        if (resp.ok) {
          console.log(`Instance "${instance}" restarted (immediate)`);
        } else {
          console.error(`Restart failed: ${body.error ?? resp.statusText}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Cannot connect to fleet (port ${port}). Is the fleet running?`);
        process.exit(1);
      }
      return;
    }

    const pidPath = join(DATA_DIR, "fleet.pid");
    if (!existsSync(pidPath)) {
      console.error("Fleet is not running (no PID file found)");
      process.exit(1);
    }
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      console.error(`Fleet PID file at ${pidPath} is corrupted`);
      process.exit(1);
    }

    if (opts?.reload) {
      // Check if managed by launchd — if so, just signal and let launchd restart
      let managedByLaunchd = false;
      try {
        const ppid = parseInt(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)]).toString().trim(), 10);
        managedByLaunchd = ppid === 1;
      } catch { /* ignore */ }

      try {
        process.kill(pid, "SIGUSR1");
      } catch {
        console.error("Failed to send reload signal (process may have exited)");
        process.exit(1);
      }

      if (managedByLaunchd) {
        console.log("Fleet is managed by launchd — sent reload signal.");
        console.log("launchd will automatically restart with new code.");
        // Wait briefly for old process to exit, then confirm new one started
        const deadline = Date.now() + 6 * 60 * 1000;
        while (Date.now() < deadline) {
          try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 500)); }
          catch { break; }
        }
        // Wait for launchd to start new process
        await new Promise(r => setTimeout(r, 2000));
        if (existsSync(pidPath)) {
          const newPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
          if (newPid !== pid) {
            console.log(`New fleet process started (PID ${newPid})`);
          }
        }
        return;
      }

      console.log("Full restart signal sent — waiting for fleet to stop...");

      // Wait for old process to exit (up to 6 minutes: 5 min idle wait + buffer)
      const deadline = Date.now() + 6 * 60 * 1000;
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0); // check if alive
          await new Promise(r => setTimeout(r, 500));
        } catch {
          break; // process exited
        }
      }
      // Verify it actually exited
      try {
        process.kill(pid, 0);
        console.error("Old fleet process still running after timeout — aborting");
        process.exit(1);
      } catch {
        // Good, it exited
      }

      console.log("Old fleet stopped. Starting with new code...");

      // Start new fleet in this process (new Node.js process = new code loaded)
      const { FleetManager } = await import("./fleet-manager.js");
      const fm = new FleetManager(DATA_DIR);
      await fm.startAll(FLEET_CONFIG_PATH);
      console.log("Fleet restarted with new code");

      // Keep process alive (same as fleet start)
      const shutdown = async () => {
        console.log("\nStopping fleet...");
        await fm.stopAll();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("uncaughtException", async (err) => {
        console.error("Uncaught exception:", err);
        await fm.stopAll().catch(() => {});
        process.exit(1);
      });
      process.on("unhandledRejection", async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("409") && msg.includes("getUpdates")) {
          console.error("Bot polling conflict (409) — retrying...");
          return;
        }
        console.error("Unhandled rejection:", err);
        await fm.stopAll().catch(() => {});
        process.exit(1);
      });
    } else {
      // Instance-only restart (existing behavior)
      try {
        process.kill(pid, "SIGUSR2");
        console.log("Graceful restart signal sent — fleet will restart when all instances are idle");
      } catch {
        console.error("Failed to send restart signal (process may have exited)");
        process.exit(1);
      }
    }
  });

fleet
  .command("status")
  .description("Show fleet status (alias for `agend ls`)")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    // Delegate to the `ls` command implementation
    await lsAction(opts);
  });

fleet
  .command("logs")
  .description("Alias for `agend logs`")
  .action(() => {
    console.log("Use `agend logs` instead. Run `agend logs --help` for options.");
  });

fleet
  .command("history")
  .description("Show fleet event history")
  .option("--instance <name>", "Filter by instance name")
  .option("--type <type>", "Filter by event type")
  .option("--since <date>", "Filter events since date (ISO format)")
  .option("--limit <n>", "Number of events to show", "50")
  .option("--json", "Output as JSON")
  .action(async (opts: { instance?: string; type?: string; since?: string; limit: string; json?: boolean }) => {
    const { EventLog } = await import("./event-log.js");
    const evLog = new EventLog(join(DATA_DIR, "events.db"));
    try {
      const rows = evLog.query({
        instance: opts.instance,
        type: opts.type,
        since: opts.since,
        limit: parseInt(opts.limit, 10),
      });
      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("No events found.");
        return;
      }
      const instWidth = Math.max(20, ...rows.map(r => r.instance_name.length + 2));
      console.log("Time".padEnd(22) + "Instance".padEnd(instWidth) + "Type".padEnd(25) + "Payload");
      console.log("\u2500".repeat(22 + instWidth + 25 + 23));
      for (const r of rows) {
        const payloadStr = r.payload != null ? JSON.stringify(r.payload) : "";
        console.log(
          r.created_at.padEnd(22) +
          r.instance_name.padEnd(instWidth) +
          r.event_type.padEnd(25) +
          payloadStr,
        );
      }
    } finally {
      evLog.close();
    }
  });

fleet
  .command("activity")
  .description("Show fleet activity log — who talked to whom, tool calls, task updates")
  .option("--since <duration>", "Time window, e.g. '2h', '30m', '1d'", "2h")
  .option("--limit <n>", "Max entries", "200")
  .option("--format <fmt>", "Output format: text or mermaid", "text")
  .action(async (opts: { since: string; limit: string; format: string }) => {
    const { EventLog } = await import("./event-log.js");
    const evLog = new EventLog(join(DATA_DIR, "events.db"));
    try {
      // Parse --since duration to ISO timestamp
      const match = opts.since.match(/^(\d+)(m|h|d)$/);
      let sinceIso: string | undefined;
      if (match) {
        const val = parseInt(match[1], 10);
        const unit = match[2] === "d" ? 86400000 : match[2] === "h" ? 3600000 : 60000;
        sinceIso = new Date(Date.now() - val * unit).toISOString();
      }

      const rows = evLog.listActivity({ since: sinceIso, limit: parseInt(opts.limit, 10) });
      if (rows.length === 0) {
        console.log("No activity found.");
        return;
      }

      if (opts.format === "mermaid") {
        console.log(generateMermaid(rows));
      } else {
        for (const r of rows) {
          const time = r.timestamp.replace("T", " ").slice(0, 19);
          const arrow = r.receiver ? `${r.sender} → ${r.receiver}` : r.sender;
          const icon = r.event === "message" ? "💬" : r.event === "tool_call" ? "🔧" : "📋";
          console.log(`${time}  ${icon} ${arrow}: ${r.summary}`);
        }
      }
    } finally {
      evLog.close();
    }
  });

function generateMermaid(rows: import("./event-log.js").ActivityRow[]): string {
  // Collect unique participants
  const participants = new Set<string>();
  for (const r of rows) {
    participants.add(r.sender);
    if (r.receiver) participants.add(r.receiver);
  }

  const lines: string[] = ["sequenceDiagram"];

  // Declare participants (shorter aliases)
  const aliases = new Map<string, string>();
  let idx = 0;
  for (const p of participants) {
    const alias = p.length > 10 ? String.fromCharCode(65 + idx++) : p;
    aliases.set(p, alias);
    lines.push(`    participant ${alias} as ${p}`);
  }

  // Generate events
  for (const r of rows) {
    const s = aliases.get(r.sender) ?? r.sender;
    const summary = r.summary.replace(/"/g, "'").slice(0, 80);
    if (r.event === "tool_call") {
      lines.push(`    Note over ${s}: 🔧 ${summary}`);
    } else if (r.receiver) {
      const recv = aliases.get(r.receiver) ?? r.receiver;
      lines.push(`    ${s}->>${recv}: ${summary}`);
    } else {
      lines.push(`    Note over ${s}: ${summary}`);
    }
  }

  return lines.join("\n");
}

fleet
  .command("cleanup")
  .description("Remove orphaned instance directories not in fleet.yaml")
  .option("--dry-run", "List orphans without deleting")
  .action(async (opts: { dryRun?: boolean }) => {
    const { FleetManager } = await import("./fleet-manager.js");
    const fm = new FleetManager(DATA_DIR);
    const config = fm.loadConfig(FLEET_CONFIG_PATH);
    const configuredNames = new Set(Object.keys(config.instances));
    const instancesDir = join(DATA_DIR, "instances");
    if (!existsSync(instancesDir)) { console.log("No instances directory."); return; }
    const dirs = readdirSync(instancesDir).filter(d => !configuredNames.has(d));
    if (dirs.length === 0) { console.log("No orphaned directories."); return; }
    console.log(`Found ${dirs.length} orphaned instance directories:`);
    for (const d of dirs) console.log(`  ${d}`);
    if (opts.dryRun) return;
    for (const d of dirs) {
      rmSync(join(instancesDir, d), { recursive: true, force: true });
      console.log(`  Removed: ${d}`);
    }
    console.log(`Cleaned up ${dirs.length} directories.`);

    // Clean stale files from active instances
    const staleFiles = ["memory.db", "sandbox-bash"];
    let staleCount = 0;
    for (const name of configuredNames) {
      const instDir = join(instancesDir, name);
      for (const f of staleFiles) {
        const p = join(instDir, f);
        if (existsSync(p)) {
          if (!opts.dryRun) rmSync(p, { force: true });
          staleCount++;
        }
      }
    }
    if (staleCount > 0) console.log(`Removed ${staleCount} stale files (memory.db, sandbox-bash).`);
  });

// === Backend commands ===
const backend = program.command("backend").description("Backend diagnostics");

backend
  .command("doctor")
  .description("Check backend prerequisites and configuration")
  .argument("[backend]", "Backend to check (claude-code, codex, gemini-cli, opencode, kiro-cli)", "claude-code")
  .action(async (backendName: string) => {
    const backends: Record<string, { binary: string; label: string; install: string; auth: string }> = {
      "claude-code": { binary: "claude", label: "Claude Code", install: "npm i -g @anthropic-ai/claude-code", auth: "claude (OAuth) or ANTHROPIC_API_KEY" },
      "codex": { binary: "codex", label: "OpenAI Codex", install: "npm i -g @openai/codex", auth: "OPENAI_API_KEY" },
      "gemini-cli": { binary: "gemini", label: "Gemini CLI", install: "npm i -g @google/gemini-cli", auth: "gemini (Google OAuth)" },
      "opencode": { binary: "opencode", label: "OpenCode", install: "go install github.com/opencode-ai/opencode@latest", auth: "Configure provider API key" },
      "kiro-cli": { binary: "kiro-cli", label: "Kiro CLI", install: "brew install --cask kiro-cli", auth: "kiro-cli login (AWS Builder ID)" },
    };
    const info = backends[backendName];
    if (!info) {
      console.error(`Unknown backend: ${backendName}. Available: ${Object.keys(backends).join(", ")}`);
      process.exit(1);
    }

    let issues = 0;
    const ok = (msg: string) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
    const fail = (msg: string) => { issues++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`); };

    console.log(`\n  \x1b[1magend backend doctor ${backendName}\x1b[0m\n`);

    // Binary
    try {
      const { execSync } = await import("node:child_process");
      const ver = execSync(`${info.binary} --version`, { stdio: "pipe" }).toString().trim();
      const which = execSync(`which ${info.binary}`, { stdio: "pipe" }).toString().trim();
      ok(`${info.binary.padEnd(20)} ${which} (${ver})`);
    } catch {
      fail(`${info.binary.padEnd(20)} not found — Install: ${info.install}`);
    }

    // tmux
    try {
      const { execSync } = await import("node:child_process");
      const ver = execSync("tmux -V", { stdio: "pipe" }).toString().trim();
      ok(`tmux${" ".repeat(16)} ${ver}`);
    } catch {
      fail(`tmux${" ".repeat(16)} not found — brew install tmux / apt install tmux`);
    }

    // TERM
    if (process.env.TERM) {
      ok(`TERM${" ".repeat(16)} ${process.env.TERM}`);
    } else {
      fail(`TERM${" ".repeat(16)} not set — may cause TUI issues in daemon mode`);
    }

    // Gemini trust check
    if (backendName === "gemini-cli") {
      try {
        const trustFile = join(homedir(), ".gemini", "trustedFolders.json");
        if (existsSync(trustFile)) {
          const trusted = JSON.parse(readFileSync(trustFile, "utf-8"));
          const count = typeof trusted === "object" ? Object.keys(trusted).length : 0;
          ok(`Trust config${" ".repeat(8)} ${count} folder(s) trusted`);
        } else {
          fail(`Trust config${" ".repeat(8)} ~/.gemini/trustedFolders.json not found`);
        }
      } catch {
        fail(`Trust config${" ".repeat(8)} Could not read trust config`);
      }
    }

    // Claude Code OAuth check
    if (backendName === "claude-code") {
      try {
        const claudeJson = join(homedir(), ".claude.json");
        if (existsSync(claudeJson)) {
          const cfg = JSON.parse(readFileSync(claudeJson, "utf-8"));
          if (cfg.oauthAccount?.accountUuid) {
            ok(`OAuth${" ".repeat(15)} Signed in`);
          } else if (process.env.ANTHROPIC_API_KEY) {
            ok(`API Key${" ".repeat(13)} ANTHROPIC_API_KEY set`);
          } else {
            fail(`Auth${" ".repeat(16)} No OAuth session or ANTHROPIC_API_KEY`);
          }
        } else if (process.env.ANTHROPIC_API_KEY) {
          ok(`API Key${" ".repeat(13)} ANTHROPIC_API_KEY set`);
        } else {
          fail(`Auth${" ".repeat(16)} No ~/.claude.json or ANTHROPIC_API_KEY`);
        }
      } catch {
        fail(`Auth${" ".repeat(16)} Could not check auth status`);
      }
    }

    console.log();
    if (issues === 0) {
      console.log(`  \x1b[32m✓ All checks passed\x1b[0m`);
    } else {
      console.log(`  \x1b[31m${issues} issue(s) found\x1b[0m`);
    }
    console.log();
  });

backend
  .command("trust")
  .description("Pre-trust working directories for a backend (prevents trust dialogs)")
  .argument("<backend>", "Backend (gemini-cli)")
  .argument("[directories...]", "Directories to trust (defaults to all fleet instance dirs)")
  .action(async (backendName: string, directories: string[]) => {
    if (backendName !== "gemini-cli") {
      console.log(`${backendName} uses CLI flags to skip trust dialogs — no manual trust needed.`);
      return;
    }

    const { GeminiCliBackend } = await import("./backend/gemini-cli.js");
    const gemini = new GeminiCliBackend(DATA_DIR);

    let dirs = directories;
    if (dirs.length === 0) {
      // Trust all fleet instance working directories
      try {
        const { loadFleetConfig } = await import("./config.js");
        const config = loadFleetConfig(FLEET_CONFIG_PATH);
        dirs = Object.values(config.instances).map(i => i.working_directory);
      } catch {
        console.error("No directories specified and no fleet config found.");
        process.exit(1);
      }
    }

    for (const dir of dirs) {
      const expanded = dir.replace(/^~/, homedir());
      gemini.preTrust(expanded);
      console.log(`  \x1b[32m✓\x1b[0m Trusted: ${expanded}`);
    }
    console.log(`\n  ${dirs.length} directory(s) trusted for Gemini CLI.`);
  });

// === Topic commands ===
const topic = program.command("topic").description("Topic binding management");

topic
  .command("list")
  .description("List topic bindings")
  .action(async () => {
    const { loadFleetConfig } = await import("./config.js");
    const config = loadFleetConfig(FLEET_CONFIG_PATH);
    let found = false;
    for (const [name, inst] of Object.entries(config.instances)) {
      if (inst.topic_id != null) {
        console.log(`${name} \u2192 topic #${inst.topic_id}`);
        found = true;
      }
    }
    if (!found) {
      console.log("No topic bindings configured");
    }
  });

topic
  .command("bind")
  .description("Bind an instance to a topic")
  .argument("<instance>", "Instance name")
  .argument("<topic-id>", "Topic ID")
  .action(async (instance: string, topicId: string) => {
    const { loadFleetConfig } = await import("./config.js");
    const yaml = await import("js-yaml");

    const config = loadFleetConfig(FLEET_CONFIG_PATH);
    if (!config.instances[instance]) {
      console.error(`Instance "${instance}" not found in fleet config`);
      process.exit(1);
    }
    config.instances[instance].topic_id = topicId;

    writeFileSync(FLEET_CONFIG_PATH, yaml.dump(config));
    console.log(`Bound ${instance} \u2192 topic #${topicId}`);
  });

topic
  .command("unbind")
  .description("Unbind an instance from its topic")
  .argument("<instance>", "Instance name")
  .action(async (instance: string) => {
    const { loadFleetConfig } = await import("./config.js");
    const yaml = await import("js-yaml");

    const config = loadFleetConfig(FLEET_CONFIG_PATH);
    if (!config.instances[instance]) {
      console.error(`Instance "${instance}" not found in fleet config`);
      process.exit(1);
    }
    delete config.instances[instance].topic_id;

    writeFileSync(FLEET_CONFIG_PATH, yaml.dump(config));
    console.log(`Unbound ${instance} from topic`);
  });

// === Access commands ===
const access = program
  .command("access")
  .description("Access control for instances");

async function resolveAccessPath(instance: string): Promise<string> {
  const { loadFleetConfig } = await import("./config.js");
  const { resolveAccessPathFromConfig } = await import("./access-path.js");
  const config = loadFleetConfig(FLEET_CONFIG_PATH);
  const inst = config.instances[instance];
  return resolveAccessPathFromConfig(DATA_DIR, instance, config.channel);
}

access
  .command("lock")
  .description("Lock instance access")
  .argument("<instance>", "Instance name")
  .action(async (instance: string) => {
    const { AccessManager } = await import("./channel/access-manager.js");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
    const statePath = await resolveAccessPath(instance);
    const am = new AccessManager({ mode: "locked", allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 }, statePath);
    am.setMode("locked");
    console.log(`${instance}: locked`);
  });

access
  .command("unlock")
  .description("Unlock instance access")
  .argument("<instance>", "Instance name")
  .action(async (instance: string) => {
    const { AccessManager } = await import("./channel/access-manager.js");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
    const statePath = await resolveAccessPath(instance);
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 }, statePath);
    am.setMode("pairing");
    console.log(`${instance}: unlocked`);
  });

access
  .command("list")
  .description("List allowed users for an instance")
  .argument("<instance>", "Instance name")
  .action(async (instance: string) => {
    const { AccessManager } = await import("./channel/access-manager.js");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
    const statePath = await resolveAccessPath(instance);
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 }, statePath);
    const users = am.getAllowedUsers();
    if (users.length === 0) {
      console.log(`${instance}: no allowed users`);
    } else {
      console.log(`${instance} allowed users:`);
      for (const uid of users) {
        console.log(`  - ${uid}`);
      }
    }
  });

access
  .command("remove")
  .description("Remove a user from allowed list")
  .argument("<instance>", "Instance name")
  .argument("<user-id>", "User ID to remove")
  .action(async (instance: string, userId: string) => {
    const { AccessManager } = await import("./channel/access-manager.js");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
    const statePath = await resolveAccessPath(instance);
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 }, statePath);
    am.removeUser(userId);
    console.log(`${instance}: removed user ${userId}`);
  });

access
  .command("pair")
  .description("Generate a pairing code for a user")
  .argument("<instance>", "Instance name")
  .argument("<user-id>", "Telegram user ID requesting pairing")
  .action(async (instance: string, userId: string) => {
    const { AccessManager } = await import("./channel/access-manager.js");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
    const statePath = await resolveAccessPath(instance);
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 }, statePath);
    const code = am.generateCode(userId);
    console.log(`${instance}: pairing code = ${code}`);
    console.log("Share this code with the user. It expires in 10 minutes.");
  });

// === Update + Reload ===
program
  .command("update")
  .description("Update AgEnD to latest version and restart service")
  .option("--skip-install", "Skip npm install, only restart service")
  .action(async (opts: { skipInstall?: boolean }) => {
    const { detectPlatform } = await import("./service-installer.js");

    if (!opts.skipInstall) {
      console.log("  Updating AgEnD...");
      try {
        execSync("npm install -g @suzuke/agend@latest", { stdio: "inherit" });
      } catch (err) {
        console.error("  Failed to update. Try: npm install -g @suzuke/agend@latest");
        process.exit(1);
      }
    }

    const plat = detectPlatform();
    const label = "com.agend.fleet";

    if (plat === "macos") {
      const plistPath = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
      if (existsSync(plistPath)) {
        const uid = process.getuid?.() ?? 501;
        console.log("  Restarting launchd service...");
        try {
          execSync(`launchctl kickstart -k gui/${uid}/${label}`, { stdio: "inherit" });
          console.log("  ✓ Service restarted with new version");
        } catch {
          console.log("  Failed to restart service. Try: launchctl kickstart -k gui/" + uid + "/" + label);
        }
        return;
      }
    } else {
      try {
        execSync(`systemctl --user restart ${label}`, { stdio: "inherit" });
        console.log("  ✓ Service restarted with new version");
        return;
      } catch { /* no systemd service */ }
    }

    // Fallback: signal running daemon
    const pidPath = join(DATA_DIR, "fleet.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try {
        process.kill(pid, "SIGUSR1");
        console.log("  ✓ Sent restart signal to running fleet (PID " + pid + ")");
      } catch {
        console.log("  Fleet not running. Start with: agend fleet start");
      }
    } else {
      console.log("  No service or running fleet found. Start with: agend fleet start");
    }
  });

program
  .command("reload")
  .description("Hot-reload fleet config (re-read fleet.yaml, start new instances)")
  .action(async () => {
    const pidPath = join(DATA_DIR, "fleet.pid");
    if (!existsSync(pidPath)) {
      console.error("Fleet is not running. Start with: agend fleet start");
      process.exit(1);
    }
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGHUP");
      console.log("✓ Sent SIGHUP to fleet (PID " + pid + ") — config will be reloaded");
    } catch {
      console.error("Fleet process not found (PID " + pid + "). It may have crashed.");
      process.exit(1);
    }
  });

// === Install/Uninstall ===
program
  .command("install")
  .description("Install as system service")
  .option("--activate", "Stop manual fleet and load the service immediately")
  .action(async (opts: { activate?: boolean }) => {
    const { installService, activateService, detectPlatform } = await import(
      "./service-installer.js"
    );
    const execPath = process.argv[1];
    const svcPath = installService({
      label: "com.agend.fleet",
      execPath,
      path: process.env.PATH!,
      workingDirectory: DATA_DIR,
      logPath: join(DATA_DIR, "fleet.log"),
    });
    console.log(`Service installed at: ${svcPath}`);
    if (opts.activate) {
      const pidPath = join(DATA_DIR, "fleet.pid");
      activateService(svcPath, pidPath);
      console.log("Service activated.");
    } else {
      const plat = detectPlatform();
      if (plat === "macos") {
        console.log(`Run: launchctl load ${svcPath}`);
      } else {
        console.log(`Run: systemctl --user enable --now com.agend.fleet`);
      }
    }
  });

program
  .command("uninstall")
  .description("Remove system service")
  .action(async () => {
    const { uninstallService } = await import("./service-installer.js");
    const removed = uninstallService("com.agend.fleet");
    if (removed) {
      console.log("Service uninstalled");
    } else {
      console.log("No service found to uninstall");
    }
  });

program
  .command("stop")
  .description("Stop the AgEnD service")
  .action(async () => {
    const { getServicePath, stopService } = await import("./service-installer.js");
    if (!getServicePath()) {
      // No service — try killing by PID
      const pidPath = join(DATA_DIR, "fleet.pid");
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        try { process.kill(pid, "SIGTERM"); console.log(`Stopped fleet (PID ${pid})`); } catch { console.log("Fleet not running."); }
      } else {
        console.log("No service installed and no running fleet found.");
      }
      return;
    }
    if (stopService()) {
      console.log("Service stopped.");
    } else {
      console.log("Service is not running or already stopped.");
    }
  });

program
  .command("start")
  .description("Start the AgEnD service (must be installed first)")
  .action(async () => {
    const { getServicePath, startService } = await import("./service-installer.js");
    if (!getServicePath()) {
      console.log("No service installed. Run: agend install");
      console.log("Or start manually: agend fleet start");
      return;
    }
    if (startService()) {
      console.log("Service started.");
    } else {
      console.log("Failed to start service. Check: agend backend doctor");
    }
  });

program
  .command("restart")
  .description("Restart the AgEnD service")
  .action(async () => {
    const { getServicePath, stopService, startService } = await import("./service-installer.js");
    if (!getServicePath()) {
      console.log("No service installed. Run: agend install");
      return;
    }
    const pidPath = join(DATA_DIR, "fleet.pid");
    let oldPid: number | null = null;
    try { oldPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10); } catch {}

    stopService();

    // Wait for old process to exit (up to 30s)
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      // Check if process is still alive
      if (oldPid) {
        try { process.kill(oldPid, 0); } catch { break; }
      } else if (!existsSync(pidPath)) {
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (startService()) {
      console.log("Service restarted.");
    } else {
      console.log("Failed to restart service.");
    }
  });

program
  .command("quickstart")
  .description("Quick 3-step setup: detect backend, create bot, connect group")
  .action(async () => {
    const { runQuickstart } = await import("./quickstart.js");
    await runQuickstart();
  });

program
  .command("init")
  .description("Interactive setup wizard (advanced)")
  .action(async () => {
    const { runSetupWizard } = await import("./setup-wizard.js");
    await runSetupWizard();
  });

program
  .command("web")
  .description("Open the Web UI dashboard in your browser")
  .action(async () => {
    const tokenPath = join(DATA_DIR, "web.token");
    if (!existsSync(tokenPath)) {
      console.error("Web token not found. Is the fleet running?");
      process.exit(1);
    }
    const token = readFileSync(tokenPath, "utf-8").trim();
    const { loadFleetConfig } = await import("./config.js");
    const fleet = loadFleetConfig(FLEET_CONFIG_PATH);
    const port = fleet.health_port ?? 19280;
    const url = `http://localhost:${port}/ui?token=${encodeURIComponent(token)}`;
    console.log(`Opening ${url}`);
    // The token is sensitive: passing it on argv would expose it via `ps`,
    // and exec(`${cmd} "${url}"`) additionally goes through a shell. Instead,
    // write a 0600-mode HTML redirect into a per-user temp dir and open that
    // file path — the token only ever lives on disk under user-only perms.
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(join(tmpdir(), "agend-web-"));
    const htmlPath = join(tmpDir, "open.html");
    const htmlUrl = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    writeFileSync(htmlPath, `<!doctype html><meta http-equiv="refresh" content="0; url=${htmlUrl}">`, { mode: 0o600 });
    const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    const child = spawn(cmd, [htmlPath], { detached: true, stdio: "ignore" });
    child.unref();
  });

// === Schedule commands ===
const schedule = program.command("schedule").description("Manage scheduled tasks");

schedule
  .command("list")
  .description("List all schedules")
  .option("--target <instance>", "Filter by target instance")
  .option("--json", "Output as JSON")
  .action((opts) => {
    const db = new SchedulerDb(join(DATA_DIR, "scheduler.db"));
    try {
      const schedules = db.list(opts.target);
      if (opts.json) {
        console.log(JSON.stringify(schedules, null, 2));
        return;
      }
      if (schedules.length === 0) {
        console.log("No schedules found.");
        return;
      }
      console.log("ID\t\t\t\t\tLabel\t\t\tCron\t\tTarget\tEnabled\tLast Status");
      for (const s of schedules) {
        console.log(`${s.id}\t${s.label ?? "-"}\t${s.cron}\t${s.target}\t${s.enabled ? "✅" : "❌"}\t${s.last_status ?? "-"}`);
      }
    } finally {
      db.close();
    }
  });

schedule
  .command("add")
  .description("Add a new schedule")
  .requiredOption("--cron <expr>", "Cron expression")
  .requiredOption("--target <instance>", "Target instance")
  .requiredOption("--message <text>", "Message to send on trigger")
  .option("--label <text>", "Human-readable name")
  .option("--timezone <tz>", "IANA timezone", "Asia/Taipei")
  .action((opts) => {
    // Validate cron expression
    try { new Cron(opts.cron, { timezone: opts.timezone }); } catch (err) {
      console.error(`Invalid cron expression: ${(err as Error).message}`);
      process.exit(1);
    }
    const db = new SchedulerDb(join(DATA_DIR, "scheduler.db"));
    try {
      const s = db.create({
        cron: opts.cron,
        message: opts.message,
        source: opts.target,
        target: opts.target,
        reply_chat_id: "",
        reply_thread_id: null,
        label: opts.label,
        timezone: opts.timezone,
      });
      console.log(`Created schedule ${s.id}`);
      signalFleetReload();
    } finally {
      db.close();
    }
  });

schedule
  .command("update")
  .description("Update an existing schedule")
  .argument("<id>", "Schedule ID")
  .option("--cron <expr>", "New cron expression")
  .option("--message <text>", "New message")
  .option("--target <instance>", "New target instance")
  .option("--label <text>", "New label")
  .option("--timezone <tz>", "New timezone")
  .option("--enabled <bool>", "Enable/disable (true/false)")
  .action((id, opts) => {
    const db = new SchedulerDb(join(DATA_DIR, "scheduler.db"));
    try {
      const params: Record<string, unknown> = {};
      if (opts.cron) params.cron = opts.cron;
      if (opts.message) params.message = opts.message;
      if (opts.target) params.target = opts.target;
      if (opts.label) params.label = opts.label;
      if (opts.timezone) params.timezone = opts.timezone;
      if (opts.enabled !== undefined) params.enabled = opts.enabled === "true";
      db.update(id, params);
      console.log(`Updated schedule ${id}`);
      signalFleetReload();
    } finally {
      db.close();
    }
  });

schedule
  .command("delete")
  .description("Delete a schedule")
  .argument("<id>", "Schedule ID")
  .action((id) => {
    const db = new SchedulerDb(join(DATA_DIR, "scheduler.db"));
    try {
      db.delete(id);
      console.log(`Deleted schedule ${id}`);
      signalFleetReload();
    } finally {
      db.close();
    }
  });

schedule
  .command("enable")
  .description("Enable a schedule")
  .argument("<id>", "Schedule ID")
  .action((id) => {
    const db = new SchedulerDb(join(DATA_DIR, "scheduler.db"));
    try {
      db.update(id, { enabled: true });
      console.log(`Enabled schedule ${id}`);
      signalFleetReload();
    } finally {
      db.close();
    }
  });

schedule
  .command("disable")
  .description("Disable a schedule")
  .argument("<id>", "Schedule ID")
  .action((id) => {
    const db = new SchedulerDb(join(DATA_DIR, "scheduler.db"));
    try {
      db.update(id, { enabled: false });
      console.log(`Disabled schedule ${id}`);
      signalFleetReload();
    } finally {
      db.close();
    }
  });

schedule
  .command("history")
  .description("Show schedule run history")
  .argument("<id>", "Schedule ID")
  .option("--limit <n>", "Number of runs to show", "20")
  .action((id, opts) => {
    const db = new SchedulerDb(join(DATA_DIR, "scheduler.db"));
    try {
      const runs = db.getRuns(id, parseInt(opts.limit, 10));
      if (runs.length === 0) {
        console.log("No runs found.");
        return;
      }
      console.log("Time\t\t\tStatus\t\t\tDetail");
      for (const r of runs) {
        console.log(`${r.triggered_at}\t${r.status}\t${r.detail ?? ""}`);
      }
    } finally {
      db.close();
    }
  });

schedule
  .command("trigger")
  .description("Manually trigger a schedule")
  .argument("<id>", "Schedule ID")
  .action((id) => {
    console.log("Manual trigger requires fleet manager running. Use the Telegram interface instead.");
  });

// === Chat Export ===
program
  .command("export-chat")
  .description("Export fleet activity as a shareable HTML chat log")
  .option("--from <time>", "Start time (ISO or HH:MM for today)")
  .option("--to <time>", "End time (ISO or HH:MM for today)")
  .option("-o, --output <path>", "Output file path")
  .action(async (opts: { from?: string; to?: string; output?: string }) => {
    const { exportChat } = await import("./chat-export.js");

    // Resolve HH:MM shorthand to full ISO date (today)
    const resolveTime = (t?: string) => {
      if (!t) return undefined;
      if (/^\d{2}:\d{2}$/.test(t)) {
        return new Date().toISOString().slice(0, 10) + " " + t + ":00";
      }
      return t;
    };

    const dbPath = join(DATA_DIR, "events.db");
    const html = exportChat(dbPath, { from: resolveTime(opts.from), to: resolveTime(opts.to) });
    const outPath = opts.output ?? `chat-export-${Date.now()}.html`;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, html, "utf-8");
    console.log(`Chat exported to ${outPath}`);
  });

// === Export / Import ===
program
  .command("export")
  .description("Export configuration for migration to another device")
  .argument("[output]", "Output file path")
  .option("--full", "Include all instance data (not just config)")
  .action(async (output?: string, opts?: { full?: boolean }) => {
    const { exportConfig } = await import("./export-import.js");
    await exportConfig(DATA_DIR, output, opts?.full ?? false);
  });

program
  .command("import")
  .description("Import configuration from an export file")
  .argument("<file>", "Path to export tarball")
  .action(async (file: string) => {
    const { importConfig } = await import("./export-import.js");
    await importConfig(DATA_DIR, file);
  });

// === Quick management commands ===

async function fuzzyMatch(query: string, names: string[]): Promise<string | null> {
  const q = query.toLowerCase();
  // Exact match
  const exact = names.find(n => n.toLowerCase() === q);
  if (exact) return exact;
  // Starts with
  const starts = names.filter(n => n.toLowerCase().startsWith(q));
  if (starts.length === 1) return starts[0];
  // Contains
  const contains = names.filter(n => n.toLowerCase().includes(q));
  if (contains.length === 1) return contains[0];
  if (contains.length > 1) {
    // Interactive selection
    console.log(`Multiple matches for "${query}":`);
    for (let i = 0; i < contains.length; i++) {
      console.log(`  ${i + 1}) ${contains[i]}`);
    }
    const { createInterface } = await import("node:readline");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise<string>(resolve => {
      rl.question("Select [1]: ", resolve);
    });
    rl.close();
    const idx = parseInt(answer.trim() || "1", 10) - 1;
    if (idx >= 0 && idx < contains.length) return contains[idx];
    console.error("Invalid selection.");
    process.exit(1);
  }
  return null;
}

async function resolveInstance(query: string, config: import("./types.js").FleetConfig): Promise<string> {
  const names = Object.keys(config.instances);
  const match = await fuzzyMatch(query, names);
  if (!match) {
    console.error(`No instance matching "${query}". Available: ${names.join(", ")}`);
    process.exit(1);
  }
  return match;
}

/** Get total RSS (KB) for a process and all its descendants. */
function getTreeRssKb(pid: number, depth = 0): number {
  if (depth > 10) return 0;
  if (!Number.isInteger(pid) || pid <= 0) return 0;
  let total = 0;
  try {
    const rss = parseInt(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { stdio: "pipe" }).toString().trim(), 10);
    if (!isNaN(rss)) total += rss;
  } catch { return 0; }
  try {
    const children = execFileSync("pgrep", ["-P", String(pid)], { stdio: "pipe" }).toString().trim();
    for (const line of children.split("\n")) {
      const childPid = parseInt(line, 10);
      if (!isNaN(childPid)) total += getTreeRssKb(childPid, depth + 1);
    }
  } catch { /* no children */ }
  return total;
}

function getInstanceStatusStandalone(name: string): "running" | "stopped" | "crashed" {
  const pidPath = join(DATA_DIR, "instances", name, "daemon.pid");
  if (!existsSync(pidPath)) return "stopped";
  const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    return "running";
  } catch {
    return "crashed";
  }
}

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")              // CSI (covers all)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")   // OSC
    .replace(/\x1b\([A-Z]/g, "")                           // Character set
    .replace(/\x1b[=>]/g, "")                              // Keypad mode
    .replace(/\r/g, "")                                     // Carriage returns
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0e-\x1f]/g, "");                // Control chars
}

function getTeamsForInstance(config: import("./types.js").FleetConfig, instanceName: string): string[] {
  if (!config.teams) return [];
  return Object.entries(config.teams)
    .filter(([, t]) => t.members.includes(instanceName))
    .map(([name]) => name);
}

function formatTimeSince(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

async function lsAction(opts: { json?: boolean }): Promise<void> {
    const yaml = (await import("js-yaml")).default;
    const config = yaml.load(readFileSync(FLEET_CONFIG_PATH, "utf-8")) as import("./types.js").FleetConfig;
    const names = Object.keys(config.instances);

    if (names.length === 0) {
      console.log("No instances configured.");
      return;
    }

    // Resolve tmux pane PIDs for memory measurement
    const { TmuxManager } = await import("./tmux-manager.js");
    const { getTmuxSession } = await import("./config.js");
    const sessionName = getTmuxSession();
    const pidByName = new Map<string, number>();
    try {
      const windows = await TmuxManager.listWindows(sessionName);
      for (const w of windows) {
        const pid = await TmuxManager.getPanePid(sessionName, w.id);
        if (pid) pidByName.set(w.name, pid);
      }
    } catch { /* tmux not running */ }

    const rows = names.map(name => {
      const status = getInstanceStatusStandalone(name);
      const teams = getTeamsForInstance(config, name);

      // Read statusline for context
      let context: number | null = null;
      const statusFile = join(DATA_DIR, "instances", name, "statusline.json");
      try {
        if (existsSync(statusFile)) {
          const data = JSON.parse(readFileSync(statusFile, "utf-8"));
          context = data.context_window?.used_percentage ?? null;
        }
      } catch { /* ignore */ }

      // Memory: sum RSS of pane process tree
      let memMb: number | null = null;
      const panePid = pidByName.get(name);
      if (panePid) {
        try {
          const rssKb = getTreeRssKb(panePid);
          if (rssKb > 0) memMb = Math.round(rssKb / 1024);
        } catch { /* ignore */ }
      }

      // Last activity: prefer statusline.json mtime (updated on real agent activity)
      let lastActivity: string | null = null;
      for (const probe of ["statusline.json", "daemon.log", "output.log"]) {
        const p = join(DATA_DIR, "instances", name, probe);
        try {
          if (existsSync(p)) {
            lastActivity = formatTimeSince(statSync(p).mtime.toISOString());
            break;
          }
        } catch { /* ignore */ }
      }

      const inst = config.instances[name];
      const backend = (inst as unknown as Record<string, unknown>)?.backend as string ?? config.defaults?.backend ?? "claude-code";

      return { name, backend, status, teams, context, memMb, lastActivity };
    });

    if (opts.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    // Status icon
    const statusIcon = (s: string) =>
      s === "running" ? "\x1b[32m●\x1b[0m" : s === "crashed" ? "\x1b[31m●\x1b[0m" : "\x1b[90m○\x1b[0m";

    const nameW = Math.max(20, ...rows.map(r => r.name.length + 2));
    const backendW = 14;
    const statusW = 12;
    const teamW = 20;
    const ctxW = 8;
    const memW = 8;

    console.log(
      "Name".padEnd(nameW) +
      "Backend".padEnd(backendW) +
      "Status".padEnd(statusW) +
      "Team".padEnd(teamW) +
      "Ctx".padEnd(ctxW) +
      "Mem".padEnd(memW) +
      "Activity"
    );
    console.log("\u2500".repeat(nameW + backendW + statusW + teamW + ctxW + memW + 10));

    for (const r of rows) {
      const teamStr = r.teams.length > 0 ? r.teams.join(",") : "-";
      const ctxStr = r.context != null ? `${Math.round(r.context)}%` : "-";
      const memStr = r.memMb != null ? `${r.memMb}MB` : "-";
      const actStr = r.lastActivity ?? "-";

      console.log(
        r.name.padEnd(nameW) +
        r.backend.padEnd(backendW) +
        statusIcon(r.status) + " " + r.status.padEnd(statusW - 2) +
        teamStr.padEnd(teamW) +
        ctxStr.padEnd(ctxW) +
        memStr.padEnd(memW) +
        actStr
      );
    }

    // System memory footer
    const totalGB = totalmem() / (1024 ** 3);
    const usedGB = (totalmem() - freemem()) / (1024 ** 3);
    console.log(`\nSystem Memory: ${usedGB.toFixed(1)} / ${totalGB.toFixed(1)} GB`);
}

program
  .command("ls")
  .description("List all instances with status, backend, team, and last activity")
  .option("--json", "Output as JSON")
  .action(async (opts: { json?: boolean }) => {
    await lsAction(opts);
  });

program
  .command("health")
  .description("Fleet health check — shows problems and diagnostics")
  .option("--json", "Output as JSON")
  .option("-q, --quiet", "One-line summary only")
  .action(async (opts: { json?: boolean; quiet?: boolean }) => {
    const { loadFleetConfig } = await import("./config.js");
    const { TmuxManager } = await import("./tmux-manager.js");
    const { getTmuxSession } = await import("./config.js");

    if (!existsSync(FLEET_CONFIG_PATH)) {
      console.error("No fleet config found. Run: agend quickstart");
      process.exit(2);
    }
    const config = loadFleetConfig(FLEET_CONFIG_PATH);
    const port = config.health_port ?? 19280;
    const sessionName = getTmuxSession();
    const names = Object.keys(config.instances);

    // Try HTTP first for rich data, fallback to local files
    let fleetUp = false;
    let fleetPid: number | null = null;
    let uptime = 0;
    let fleetApiData: Record<string, { ipc: boolean; rateLimits: { five_hour_pct: number; seven_day_pct: number } | null; lastActivity: number | null }> = {};

    const pidPath = join(DATA_DIR, "fleet.pid");
    try {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      process.kill(pid, 0);
      fleetPid = pid;
      fleetUp = true;
    } catch { /* fleet not running */ }

    if (fleetUp) {
      try {
        const resp = await fetch(`http://127.0.0.1:${port}/api/fleet`, { signal: AbortSignal.timeout(3000) });
        const data = await resp.json() as { uptime_seconds?: number; instances?: Array<{ name: string; ipc: boolean; rateLimits: { five_hour_pct: number; seven_day_pct: number } | null; lastActivity: number | null }> };
        uptime = data.uptime_seconds ?? 0;
        for (const inst of data.instances ?? []) {
          fleetApiData[inst.name] = { ipc: inst.ipc, rateLimits: inst.rateLimits, lastActivity: inst.lastActivity };
        }
      } catch { /* API not reachable, use local data */ }
    }

    // Tmux windows
    const tmuxWindows = new Set<string>();
    try {
      const windows = await TmuxManager.listWindows(sessionName);
      for (const w of windows) tmuxWindows.add(w.name);
    } catch { /* tmux not running */ }

    // Per-instance health
    type HealthStatus = "ok" | "idle" | "degraded" | "no-ipc" | "crash" | "stopped";
    interface InstanceHealth {
      name: string;
      status: HealthStatus;
      issues: string[];
      general: boolean;
    }

    const results: InstanceHealth[] = names.map(name => {
      const instConfig = config.instances[name];
      const isGeneral = instConfig.general_topic === true;
      const issues: string[] = [];

      // Process alive?
      const procStatus = getInstanceStatusStandalone(name);
      if (procStatus === "crashed") {
        issues.push("Process dead (daemon.pid stale)");
        // Check crash-state.json
        const crashState = join(DATA_DIR, "instances", name, "crash-state.json");
        if (existsSync(crashState)) issues.push("Crash loop detected (crash-state.json present)");
        return { name, status: "crash" as HealthStatus, issues, general: isGeneral };
      }
      if (procStatus === "stopped") {
        return { name, status: "stopped" as HealthStatus, issues: ["Not running"], general: isGeneral };
      }

      // Tmux window alive?
      if (!tmuxWindows.has(name)) issues.push("Tmux window missing");

      // IPC connected? (from API data)
      const api = fleetApiData[name];
      if (api && !api.ipc) issues.push("IPC disconnected");

      // Rate limits
      const rl = api?.rateLimits;
      if (rl && rl.five_hour_pct >= 90) issues.push(`Rate limited (5h: ${Math.round(rl.five_hour_pct)}%)`);
      if (rl && rl.seven_day_pct >= 95) issues.push(`Weekly limit critical (7d: ${Math.round(rl.seven_day_pct)}%)`);

      // Idle check
      const lastAct = api?.lastActivity;
      const idleMs = lastAct ? Date.now() - lastAct : null;
      const idleHours = idleMs ? idleMs / 3600000 : null;
      if (idleHours && idleHours > 1) issues.push(`Idle ${Math.round(idleHours)}h`);

      // Determine status
      let status: HealthStatus = "ok";
      if (issues.some(i => i.includes("Tmux") || i.includes("IPC"))) status = "no-ipc";
      if (issues.some(i => i.includes("Rate") || i.includes("Weekly"))) status = "degraded";
      if (issues.some(i => i.includes("Idle")) && status === "ok") status = "idle";

      return { name, status, issues, general: isGeneral };
    });

    // Fleet classification
    const crashed = results.filter(r => r.status === "crash");
    const problems = results.filter(r => r.status !== "ok" && r.status !== "idle" && r.status !== "stopped");
    const healthy = results.filter(r => r.status === "ok" || r.status === "idle");
    const stopped = results.filter(r => r.status === "stopped");
    const generalDown = results.some(r => r.general && r.status !== "ok" && r.status !== "idle");

    let classification: "healthy" | "degraded" | "unhealthy";
    if (generalDown || crashed.length > 0) classification = "unhealthy";
    else if (problems.length > 0) classification = "degraded";
    else classification = "healthy";

    const exitCode = classification === "healthy" ? 0 : fleetUp ? 1 : 2;

    if (opts.json) {
      console.log(JSON.stringify({ fleet: { running: fleetUp, pid: fleetPid, uptime, classification }, instances: results }, null, 2));
      process.exit(exitCode);
    }

    if (opts.quiet) {
      const icon = classification === "healthy" ? "✓" : classification === "degraded" ? "⚠" : "✗";
      console.log(`${icon} ${classification}: ${healthy.length}/${names.length} healthy${problems.length > 0 ? `, ${problems.length} issues` : ""}`);
      process.exit(exitCode);
    }

    // Full output
    const fleetIcon = fleetUp ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    const upH = Math.floor(uptime / 3600);
    const upM = Math.floor((uptime % 3600) / 60);
    console.log(`Fleet: ${fleetIcon} ${fleetUp ? `running (uptime ${upH}h ${upM}m, PID ${fleetPid})` : "not running"}`);
    console.log(`Instances: ${healthy.length} healthy, ${problems.length + crashed.length} issues, ${stopped.length} stopped\n`);

    // Only show instances with problems
    const unhealthy = results.filter(r => r.issues.length > 0 && r.status !== "stopped");
    if (unhealthy.length === 0) {
      console.log("\x1b[32m✓ All instances healthy\x1b[0m");
    } else {
      for (const inst of unhealthy) {
        const icon = inst.status === "crash" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m⚠\x1b[0m";
        console.log(`${icon} ${inst.name}${inst.general ? " (general)" : ""}`);
        for (const issue of inst.issues) {
          console.log(`    ${issue}`);
        }
      }
    }

    const classIcon = classification === "healthy" ? "\x1b[32m✓\x1b[0m" : classification === "degraded" ? "\x1b[33m⚠\x1b[0m" : "\x1b[31m✗\x1b[0m";
    console.log(`\n${classIcon} Fleet: ${classification}`);
    process.exit(exitCode);
  });

program
  .command("attach")
  .description("Attach to an instance's tmux window (fuzzy match)")
  .argument("<name>", "Instance name (supports fuzzy matching)")
  .action(async (query: string) => {
    const yaml = (await import("js-yaml")).default;
    const config = yaml.load(readFileSync(FLEET_CONFIG_PATH, "utf-8")) as import("./types.js").FleetConfig;
    const name = await resolveInstance(query, config);
    const status = getInstanceStatusStandalone(name);

    if (status !== "running") {
      console.error(`Instance "${name}" is ${status}. Start it first with: agend fleet start ${name}`);
      process.exit(1);
    }

    // Read window-id for the instance
    const windowIdPath = join(DATA_DIR, "instances", name, "window-id");
    let windowId: string | null = null;
    try {
      if (existsSync(windowIdPath)) {
        windowId = readFileSync(windowIdPath, "utf-8").trim();
      }
    } catch { /* ignore */ }

    const session = "agend";

    // Verify tmux session exists
    try {
      execFileSync("tmux", tmuxArgs(["has-session", "-t", session]), { stdio: "pipe" });
    } catch {
      console.error(`tmux session "${session}" not found. Is the fleet running?`);
      process.exit(1);
    }

    // Try window-id first (precise), then window name (fallback for stale id)
    const targets = windowId
      ? [`${session}:${windowId}`, `${session}:${name}`]
      : [`${session}:${name}`];
    let selected = false;
    for (const t of targets) {
      try { execFileSync("tmux", tmuxArgs(["select-window", "-t", t]), { stdio: "pipe" }); selected = true; break; }
      catch { /* try next */ }
    }
    if (!selected) {
      console.error(`Cannot find tmux window for "${name}". The instance may need to be restarted.`);
      process.exit(1);
    }

    // Attach or switch-client depending on whether we're already in tmux
    if (process.env.TMUX) {
      // Already inside tmux — switch client
      try {
        execFileSync("tmux", tmuxArgs(["switch-client", "-t", session]), { stdio: "inherit" });
      } catch {
        console.error("Failed to switch tmux client.");
        process.exit(1);
      }
    } else {
      // Outside tmux — attach
      try {
        execFileSync("tmux", tmuxArgs(["attach-session", "-t", session]), { stdio: "inherit" });
      } catch {
        console.error("Failed to attach to tmux session.");
        process.exit(1);
      }
    }
  });

program
  .command("logs")
  .description("Show fleet log (alias for `agend fleet logs`)")
  .option("-n, --lines <count>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output (like tail -f)")
  .option("--instance <name>", "Filter by instance name")
  .action((opts: { lines: string; follow?: boolean; instance?: string }) => {
    const logPath = join(DATA_DIR, "fleet.log");
    if (!existsSync(logPath)) {
      console.error("No fleet log found. Is the fleet running?");
      process.exit(1);
    }

    if (opts.follow) {
      const tailArgs = ["-n", opts.lines, "-f", logPath];
      const tail = spawn("tail", tailArgs, { stdio: ["ignore", "pipe", "inherit"] });
      tail.stdout!.on("data", (chunk: Buffer) => {
        const lines = stripAnsi(chunk.toString()).split("\n");
        for (const line of lines) {
          if (!opts.instance || line.includes(opts.instance)) process.stdout.write(line + "\n");
        }
      });
      tail.on("close", () => process.exit(0));
      process.on("SIGINT", () => { tail.kill(); process.exit(0); });
      return;
    }

    const content = readFileSync(logPath, "utf-8");
    let lines = content.trim().split("\n");
    if (opts.instance) lines = lines.filter(l => l.includes(opts.instance!));
    const n = parseInt(opts.lines, 10);
    console.log(stripAnsi(lines.slice(-n).join("\n")));
  });

program.parse();
