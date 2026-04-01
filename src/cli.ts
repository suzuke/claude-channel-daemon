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
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(homedir(), ".agend");
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
  .option("--reload", "Full process restart to load new code")
  .action(async (opts: { reload?: boolean }) => {
    const pidPath = join(DATA_DIR, "fleet.pid");
    if (!existsSync(pidPath)) {
      console.error("Fleet is not running (no PID file found)");
      process.exit(1);
    }
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);

    if (opts.reload) {
      // Check if managed by launchd — if so, just signal and let launchd restart
      let managedByLaunchd = false;
      try {
        const ppid = parseInt(execSync(`ps -o ppid= -p ${pid}`).toString().trim(), 10);
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
  .description("Show fleet status")
  .action(async () => {
    const { FleetManager } = await import("./fleet-manager.js");
    const fm = new FleetManager(DATA_DIR);
    const config = fm.loadConfig(FLEET_CONFIG_PATH);

    const names = Object.keys(config.instances);
    const nameWidth = Math.max(20, ...names.map(n => n.length + 2));

    console.log("Instance".padEnd(nameWidth) + "Status".padEnd(10) + "Context".padEnd(10) + "Cost".padEnd(10) + "Topic");
    console.log("\u2500".repeat(nameWidth + 40));
    for (const [name, inst] of Object.entries(config.instances)) {
      const status = fm.getInstanceStatus(name);
      const topic = inst.topic_id ? `#${inst.topic_id}` : "(DM)";

      // Read statusline.json for context usage and cost
      let contextStr = "-";
      let costStr = "-";
      const statusFile = join(DATA_DIR, "instances", name, "statusline.json");
      try {
        if (existsSync(statusFile)) {
          const data = JSON.parse(readFileSync(statusFile, "utf-8"));
          if (data.context_window?.used_percentage != null) {
            contextStr = `${Math.round(data.context_window.used_percentage)}%`;
          }
          if (data.cost?.total_cost_usd != null) {
            costStr = `$${data.cost.total_cost_usd.toFixed(2)}`;
          }
        }
      } catch { /* ignore read errors */ }

      console.log(
        name.padEnd(nameWidth) +
        status.padEnd(10) +
        contextStr.padEnd(10) +
        costStr.padEnd(10) +
        topic,
      );
    }
  });

fleet
  .command("logs")
  .description("Show instance logs")
  .argument("<instance>", "Instance name")
  .option("-n, --lines <count>", "Number of lines to show", "50")
  .action((instance: string, opts: { lines: string }) => {
    const logPath = join(DATA_DIR, "instances", instance, "daemon.log");
    if (!existsSync(logPath)) {
      console.error(`No logs found for instance "${instance}"`);
      process.exit(1);
    }
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    const n = parseInt(opts.lines, 10);
    console.log(lines.slice(-n).join("\n"));
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
  .argument("[backend]", "Backend to check (claude-code, codex, gemini-cli, opencode)", "claude-code")
  .action(async (backendName: string) => {
    const backends: Record<string, { binary: string; label: string; install: string; auth: string }> = {
      "claude-code": { binary: "claude", label: "Claude Code", install: "npm i -g @anthropic-ai/claude-code", auth: "claude (OAuth) or ANTHROPIC_API_KEY" },
      "codex": { binary: "codex", label: "OpenAI Codex", install: "npm i -g @openai/codex", auth: "OPENAI_API_KEY" },
      "gemini-cli": { binary: "gemini", label: "Gemini CLI", install: "npm i -g @google/gemini-cli", auth: "gemini (Google OAuth)" },
      "opencode": { binary: "opencode", label: "OpenCode", install: "go install github.com/opencode-ai/opencode@latest", auth: "Configure provider API key" },
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
        execSync("npm update -g @suzuke/agend", { stdio: "inherit" });
      } catch (err) {
        console.error("  Failed to update. Try: sudo npm update -g @suzuke/agend");
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
  .command("init")
  .description("Interactive setup wizard")
  .action(async () => {
    const { runSetupWizard } = await import("./setup-wizard.js");
    await runSetupWizard();
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

program.parse();
