#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { join } from "node:path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
      const rl = createInterface({
        input: createReadStream(LOG_PATH, { start: 0 }),
      });
      rl.on("line", (line: string) => console.log(line));
      process.stdin.resume();
    } else {
      const content = readFileSync(LOG_PATH, "utf-8");
      const lines = content.trim().split("\n");
      const n = parseInt(opts.lines, 10);
      console.log(lines.slice(-n).join("\n"));
    }
  });

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
      const ports = fm.allocatePorts(config.instances);
      const topicMode = config.channel?.mode === "topic" && !inst.channel;
      await fm.startInstance(instance, inst, ports[instance], topicMode);
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
  });

fleet
  .command("stop")
  .description("Stop fleet or specific instance")
  .argument("[instance]", "Specific instance to stop")
  .action(async (instance?: string) => {
    const { FleetManager } = await import("./fleet-manager.js");
    const fm = new FleetManager(DATA_DIR);
    if (instance) {
      await fm.stopInstance(instance);
    } else {
      await fm.stopAll();
    }
    console.log("Stopped");
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

program.parse();
