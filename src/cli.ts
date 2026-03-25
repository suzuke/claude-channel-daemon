#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
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
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DATA_DIR = join(homedir(), ".claude-channel-daemon");
const DEFAULT_CONFIG_PATH = join(DATA_DIR, "config.yaml");
const FLEET_CONFIG_PATH = join(DATA_DIR, "fleet.yaml");
const PID_PATH = join(DATA_DIR, "daemon.pid");
const LOG_PATH = join(DATA_DIR, "daemon.log");

const program = new Command();

program
  .name("ccd")
  .description("Claude Channel Daemon")
  .version("0.2.0");

// === Single-instance (backward compat) ===
program
  .command("start")
  .description("Start single daemon instance (legacy)")
  .option("-c, --config <path>", "Config file path", DEFAULT_CONFIG_PATH)
  .action(async (opts) => {
    const { Daemon } = await import("./daemon.js");
    const config = loadConfig(opts.config);

    // Map DaemonConfig → InstanceConfig
    const instanceConfig = {
      working_directory: config.working_directory,
      restart_policy: config.restart_policy,
      context_guardian: config.context_guardian,
      memory: config.memory,
      memory_directory: config.memory_directory,
      log_level: config.log_level,
      channel_plugin: config.channel_plugin,
    };

    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(PID_PATH, String(process.pid));

    const instanceDir = join(DATA_DIR, "instances", "default");
    const daemon = new Daemon("default", instanceConfig as any, instanceDir);
    await daemon.start();

    const shutdown = async () => {
      await daemon.stop();
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
      console.log("Daemon stopped");
    } catch {
      console.error("Failed to stop daemon (process may have already exited)");
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // ignore
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
  .action((opts) => {
    if (!existsSync(LOG_PATH)) {
      console.error("No log file found");
      process.exit(1);
    }
    if (opts.follow) {
      const tail = spawn("tail", ["-f", LOG_PATH], { stdio: "inherit" });
      tail.on("close", () => process.exit(0));
      process.on("SIGINT", () => { tail.kill(); process.exit(0); });
      return;
    } else {
      const content = readFileSync(LOG_PATH, "utf-8");
      const lines = content.trim().split("\n");
      const n = parseInt(opts.lines, 10);
      console.log(lines.slice(-n).join("\n"));
    }
  });

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
  .action(async () => {
    const pidPath = join(DATA_DIR, "fleet.pid");
    if (!existsSync(pidPath)) {
      console.error("Fleet is not running (no PID file found)");
      process.exit(1);
    }
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGUSR2");
      console.log("Graceful restart signal sent — fleet will restart when all instances are idle");
    } catch {
      console.error("Failed to send restart signal (process may have exited)");
      process.exit(1);
    }
  });

fleet
  .command("status")
  .description("Show fleet status")
  .action(async () => {
    const { FleetManager } = await import("./fleet-manager.js");
    const fm = new FleetManager(DATA_DIR);
    const config = fm.loadConfig(FLEET_CONFIG_PATH);

    console.log("Instance".padEnd(15) + "Status".padEnd(12) + "Topic");
    console.log("\u2500".repeat(40));
    for (const [name, inst] of Object.entries(config.instances)) {
      const status = fm.getInstanceStatus(name);
      const topic = inst.topic_id ? `#${inst.topic_id}` : "(DM)";
      console.log(name.padEnd(15) + status.padEnd(12) + topic);
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

access
  .command("lock")
  .description("Lock instance access")
  .argument("<instance>", "Instance name")
  .action(async (instance: string) => {
    const { AccessManager } = await import("./channel/access-manager.js");
    const statePath = join(DATA_DIR, "instances", instance, "access-state.json");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
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
    const statePath = join(DATA_DIR, "instances", instance, "access-state.json");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
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
    const statePath = join(DATA_DIR, "instances", instance, "access-state.json");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
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
    const statePath = join(DATA_DIR, "instances", instance, "access-state.json");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
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
    const statePath = join(DATA_DIR, "instances", instance, "access-state.json");
    const instanceDir = join(DATA_DIR, "instances", instance);
    if (!existsSync(instanceDir)) {
      console.error(`Instance "${instance}" not found`);
      process.exit(1);
    }
    const am = new AccessManager({ mode: "pairing", allowed_users: [], max_pending_codes: 5, code_expiry_minutes: 10 }, statePath);
    const code = am.generateCode(parseInt(userId, 10));
    console.log(`${instance}: pairing code = ${code}`);
    console.log("Share this code with the user. It expires in 10 minutes.");
  });

// === Install/Uninstall ===
program
  .command("install")
  .description("Install as system service")
  .action(async () => {
    const { installService, detectPlatform } = await import(
      "./service-installer.js"
    );
    const execPath = process.argv[1];
    const path = installService({
      label: "com.ccd.fleet",
      execPath,
      workingDirectory: DATA_DIR,
      logPath: join(DATA_DIR, "fleet.log"),
    });
    console.log(`Service installed at: ${path}`);
    const plat = detectPlatform();
    if (plat === "macos") {
      console.log(`Run: launchctl load ${path}`);
    } else {
      console.log("Run: systemctl --user enable --now ccd");
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
