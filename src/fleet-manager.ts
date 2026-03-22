import { fork, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import type { FleetConfig, InstanceConfig } from "./types.js";
import { loadFleetConfig } from "./config.js";
import { TmuxManager } from "./tmux-manager.js";

const BASE_PORT = 18321;
const TMUX_SESSION = "ccd";

export class FleetManager {
  private children: Map<string, ChildProcess> = new Map();
  private fleetConfig: FleetConfig | null = null;

  constructor(private dataDir: string) {}

  /** Load fleet.yaml and build routing table */
  loadConfig(configPath: string): FleetConfig {
    this.fleetConfig = loadFleetConfig(configPath);
    return this.fleetConfig;
  }

  /** Build topic routing table: { topicId -> instanceName } */
  buildRoutingTable(): Map<number, string> {
    const table = new Map<number, string>();
    if (!this.fleetConfig) return table;
    for (const [name, inst] of Object.entries(this.fleetConfig.instances)) {
      if (inst.topic_id != null) {
        table.set(inst.topic_id, name);
      }
    }
    return table;
  }

  /** Allocate approval ports — use explicit port if set, otherwise auto-increment */
  allocatePorts(instances: Record<string, Partial<InstanceConfig>>): Record<string, number> {
    const ports: Record<string, number> = {};
    let auto = BASE_PORT;
    for (const [name, config] of Object.entries(instances)) {
      ports[name] = config.approval_port ?? auto++;
    }
    return ports;
  }

  getInstanceDir(name: string): string {
    return join(this.dataDir, "instances", name);
  }

  getInstanceStatus(name: string): "running" | "stopped" | "crashed" {
    const pidPath = join(this.getInstanceDir(name), "daemon.pid");
    if (!existsSync(pidPath)) return "stopped";
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return "running";
    } catch {
      return "crashed";
    }
  }

  async startInstance(name: string, config: InstanceConfig, port: number, topicMode: boolean): Promise<void> {
    const instanceDir = this.getInstanceDir(name);
    mkdirSync(instanceDir, { recursive: true });

    const entryPath = join(__dirname, "daemon-entry.js");
    const args = [
      "--instance", name,
      "--instance-dir", instanceDir,
      "--port", String(port),
      "--config", JSON.stringify(config),
    ];
    if (topicMode) args.push("--topic-mode");

    const child = fork(entryPath, args, {
      cwd: config.working_directory,
      detached: false,
      silent: true,
    });

    this.children.set(name, child);
    child.on("exit", () => this.children.delete(name));
  }

  async stopInstance(name: string): Promise<void> {
    const child = this.children.get(name);
    if (child) {
      child.kill("SIGTERM");
      this.children.delete(name);
      return;
    }
    // Try PID file fallback
    const pidPath = join(this.getInstanceDir(name), "daemon.pid");
    if (existsSync(pidPath)) {
      const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }

  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.children.keys()].map(name => this.stopInstance(name))
    );
  }

  /** Start all instances from fleet config */
  async startAll(configPath: string): Promise<void> {
    const fleet = this.loadConfig(configPath);
    const topicMode = fleet.channel?.mode === "topic";
    const ports = this.allocatePorts(fleet.instances);

    // Ensure tmux session exists
    await TmuxManager.ensureSession(TMUX_SESSION);

    for (const [name, config] of Object.entries(fleet.instances)) {
      await this.startInstance(name, config, ports[name], topicMode && !config.channel);
    }
  }
}
