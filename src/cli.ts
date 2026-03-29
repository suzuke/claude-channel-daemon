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
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(homedir(), ".claude-channel-daemon");
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
  .name("ccd")
  .description("Claude Channel Daemon")
  .version(pkgVersion);

function signalFleetReload(): void {
  const pidPath = join(DATA_DIR, "fleet.pid");
  try {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    process.kill(pid, "SIGHUP");
    console.log("Fleet manager notified to reload schedules.");
  } catch {
    console.log("Fleet manager not running. Schedules will be loaded on next start.");
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
      const topicMode = config.channel?.mode === "topic" && !inst.channel;
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
      // Full restart: graceful stop old process, then start new fleet in this process
      try {
        process.kill(pid, "SIGUSR1");
      } catch {
        console.error("Failed to send reload signal (process may have exited)");
        process.exit(1);
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

    console.log("Instance".padEnd(20) + "Status".padEnd(10) + "Context".padEnd(10) + "Cost".padEnd(10) + "Topic");
    console.log("\u2500".repeat(65));
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
        name.padEnd(20) +
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
      console.log("Time".padEnd(22) + "Instance".padEnd(20) + "Type".padEnd(25) + "Payload");
      console.log("\u2500".repeat(90));
      for (const r of rows) {
        const payloadStr = r.payload != null ? JSON.stringify(r.payload) : "";
        console.log(
          r.created_at.padEnd(22) +
          r.instance_name.padEnd(20) +
          r.event_type.padEnd(25) +
          payloadStr,
        );
      }
    } finally {
      evLog.close();
    }
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
    config.instances[instance].topic_id = parseInt(topicId, 10);

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
  return resolveAccessPathFromConfig(DATA_DIR, instance, config.channel, inst?.channel);
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
    am.removeUser(parseInt(userId, 10));
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
    const code = am.generateCode(parseInt(userId, 10));
    console.log(`${instance}: pairing code = ${code}`);
    console.log("Share this code with the user. It expires in 10 minutes.");
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
      label: "com.ccd.fleet",
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
        console.log(`Run: systemctl --user enable --now com.ccd.fleet`);
      }
    }
  });

program
  .command("uninstall")
  .description("Remove system service")
  .action(async () => {
    const { uninstallService } = await import("./service-installer.js");
    const removed = uninstallService("com.ccd.fleet");
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
