import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { access } from "node:fs/promises";
import type { InstanceConfig, FleetConfig } from "./types.js";
import { DEFAULT_INSTANCE_CONFIG } from "./config.js";
import { sanitizeInstanceName } from "./topic-commands.js";
import { RoutingEngine } from "./routing-engine.js";
import { safeHandler } from "./safe-async.js";
import type { Logger } from "./logger.js";
import type { IpcClient } from "./channel/ipc-bridge.js";
import type { EventLog } from "./event-log.js";
import type { TmuxControlClient } from "./tmux-control.js";

/**
 * Context interface for instance lifecycle operations.
 * FleetManager implements this.
 */
export interface LifecycleContext {
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly routing: RoutingEngine;
  readonly instanceIpcClients: Map<string, IpcClient>;
  readonly sessionRegistry: Map<string, string>;
  readonly eventLog: EventLog | null;
  readonly controlClient: TmuxControlClient | null;

  getInstanceDir(name: string): string;
  saveFleetConfig(): void;
  connectIpcToInstance(name: string): Promise<void>;
  createForumTopic(topicName: string): Promise<number | string>;
  deleteForumTopic(topicId: number | string): Promise<void>;
  setTopicIcon(name: string, state: "green" | "blue" | "red" | "remove"): void;
  /** Remove instance with full cleanup (scheduler, IPC, routing, config). */
  removeInstance(name: string): Promise<void>;
  touchActivity(name: string): void;
  sendHangNotification(name: string): Promise<void>;
  notifyInstanceTopic(name: string, text: string): void;
  webhookEmit(event: string, name: string, data?: Record<string, unknown>): void;
  checkModelFailover(name: string, fiveHourPct: number): void;
  startStatuslineWatcher(name: string): void;
}

type Daemon = InstanceType<typeof import("./daemon.js").Daemon>;

export class InstanceLifecycle {
  /** Active daemon processes: instanceName → Daemon */
  readonly daemons = new Map<string, Daemon>();

  constructor(private ctx: LifecycleContext) {}

  async start(name: string, config: InstanceConfig, topicMode: boolean): Promise<void> {
    if (this.daemons.has(name)) {
      this.ctx.logger.info({ name }, "Instance already running, skipping");
      return;
    }

    if (!existsSync(config.working_directory)) {
      this.ctx.logger.info({ name, working_directory: config.working_directory }, "Working directory does not exist — creating it");
      mkdirSync(config.working_directory, { recursive: true });
    }

    const instanceDir = this.ctx.getInstanceDir(name);
    mkdirSync(instanceDir, { recursive: true });

    const { Daemon } = await import("./daemon.js");
    const { createBackend } = await import("./backend/factory.js");

    const backendName = config.backend ?? this.ctx.fleetConfig?.defaults?.backend ?? "claude-code";
    const backend = createBackend(backendName, instanceDir);
    const daemon = new Daemon(name, config, instanceDir, topicMode, backend, this.ctx.controlClient ?? undefined);
    // Catch errors from daemon internals (e.g. IPC server) to prevent crashing the fleet process
    daemon.on("error", (err: Error) => {
      this.ctx.logger.error({ err, name }, "Daemon emitted error — instance isolated");
    });
    await daemon.start();
    this.daemons.set(name, daemon);

    daemon.on("restart_complete", safeHandler((data: Record<string, unknown>) => {
      this.ctx.eventLog?.insert(name, "context_rotation", data);
      this.ctx.logger.info({ name, ...data }, "Context restart completed");
    }, this.ctx.logger, `daemon.restart_complete[${name}]`));

    const hangDetector = daemon.getHangDetector();
    if (hangDetector) {
      hangDetector.on("hang", safeHandler(async () => {
        this.ctx.eventLog?.insert(name, "hang_detected", {});
        this.ctx.logger.warn({ name }, "Instance appears hung");
        await this.ctx.sendHangNotification(name);
        this.ctx.webhookEmit("hang", name);
      }, this.ctx.logger, `hangDetector[${name}]`));
    }

    daemon.on("crash_respawn", safeHandler(() => {
      this.ctx.eventLog?.insert(name, "crash_respawn", {});
      this.ctx.logger.warn({ name }, "Instance crashed and respawned");
      this.ctx.notifyInstanceTopic(name, `⚠️ ${name} crashed and respawned.`);
      const generalName = this.findGeneralInstance();
      if (generalName && generalName !== name) {
        this.ctx.notifyInstanceTopic(generalName, `⚠️ ${name} crashed and respawned. Check ~/.agend/daemon.log for details.`);
      }
    }, this.ctx.logger, `daemon.crash_respawn[${name}]`));

    daemon.on("snapshot_failed", safeHandler(() => {
      this.ctx.eventLog?.insert(name, "snapshot_failed", {});
      this.ctx.notifyInstanceTopic(name, `⚠️ ${name}: restarted without context (snapshot injection failed)`);
    }, this.ctx.logger, `daemon.snapshot_failed[${name}]`));

    daemon.on("crash_loop", safeHandler(() => {
      this.ctx.eventLog?.insert(name, "crash_loop", {});
      this.ctx.logger.error({ name }, "Instance in crash loop — respawn paused");
      this.ctx.notifyInstanceTopic(name, `🔴 ${name} keeps crashing shortly after launch — respawn paused. Check rate limits or run \`agend fleet restart\`.`);
      this.ctx.setTopicIcon(name, "red");
    }, this.ctx.logger, `daemon.crash_loop[${name}]`));

    daemon.on("pty_error", safeHandler((data: { name: string; type: string; action: string; message: string }) => {
      this.ctx.eventLog?.insert(name, "pty_error", { type: data.type, action: data.action });
      this.ctx.logger.warn({ name, errorType: data.type, action: data.action }, `PTY error: ${data.message}`);

      const emoji = data.type === "rate_limit" ? "⏳" : data.type === "auth_error" ? "🔑" : "⚠️";
      this.ctx.notifyInstanceTopic(name, `${emoji} ${name}: ${data.message} (action: ${data.action})`);
      this.ctx.webhookEmit("pty_error", name, { type: data.type, action: data.action, message: data.message });

      if (data.action === "failover") {
        this.ctx.checkModelFailover(name, 100); // Force failover trigger
      }
    }, this.ctx.logger, `daemon.pty_error[${name}]`));

    daemon.on("pty_recovered", safeHandler((data: { name: string; downtime_s: number }) => {
      const mins = Math.floor(data.downtime_s / 60);
      const secs = data.downtime_s % 60;
      const duration = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      this.ctx.eventLog?.insert(name, "pty_recovered", { downtime_s: data.downtime_s });
      this.ctx.logger.info({ name, downtime_s: data.downtime_s }, "PTY error recovered");
      this.ctx.notifyInstanceTopic(name, `✅ ${name}: recovered after ${duration}`);
      this.ctx.webhookEmit("pty_recovered", name, { downtime_s: data.downtime_s });
    }, this.ctx.logger, `daemon.pty_recovered[${name}]`));

    this.ctx.setTopicIcon(name, "green");
    this.ctx.touchActivity(name);
  }

  async stop(name: string): Promise<void> {
    this.ctx.setTopicIcon(name, "remove");

    const daemon = this.daemons.get(name);
    if (daemon) {
      await daemon.stop();
      this.daemons.delete(name);
    } else {
      const pidPath = join(this.ctx.getInstanceDir(name), "daemon.pid");
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        try { process.kill(pid, "SIGTERM"); } catch (e) { this.ctx.logger.debug({ err: e, pid }, "SIGTERM failed for stale process"); }
      }
    }

    // Clean up IPC client (prevents stale routing after stop)
    const ipc = this.ctx.instanceIpcClients.get(name);
    if (ipc) {
      try { ipc.close(); } catch { /* already closed */ }
      this.ctx.instanceIpcClients.delete(name);
    }
    // Clean up session registry entries pointing to this instance
    for (const [session, instance] of this.ctx.sessionRegistry) {
      if (instance === name) this.ctx.sessionRegistry.delete(session);
    }
  }

  async remove(name: string): Promise<void> {
    const config = this.ctx.fleetConfig?.instances[name];
    if (!config) return;

    // Never remove the General instance
    if (config.general_topic) {
      this.ctx.logger.warn({ name }, "Refusing to remove General instance");
      return;
    }

    // Clean up schedules
    // Access scheduler through fleetConfig — scheduler is managed by FleetManager
    // We just clean up instance-related data here

    // Stop daemon if running
    if (this.daemons.has(name)) {
      await this.stop(name);
    }

    // Clean up git worktree if applicable
    if (config.worktree_source && config.working_directory) {
      if (!existsSync(config.working_directory)) {
        this.ctx.logger.info({ worktree: config.working_directory }, "Worktree directory already gone, skipping removal");
      } else {
        try {
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFileCb);
          await execFileAsync("git", ["worktree", "remove", "--force", config.working_directory], {
            cwd: config.worktree_source,
          });
          this.ctx.logger.info({ worktree: config.working_directory }, "Removed git worktree");
        } catch (err) {
          this.ctx.logger.warn({ err, worktree: config.working_directory }, "Failed to remove git worktree");
        }
      }
      // Prune stale worktree records (e.g. if directory was manually deleted)
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFileCb);
        await execFileAsync("git", ["worktree", "prune"], { cwd: config.worktree_source });
      } catch { /* best effort */ }
    }

    // Clean up IPC
    const ipc = this.ctx.instanceIpcClients.get(name);
    if (ipc) {
      await ipc.close();
      this.ctx.instanceIpcClients.delete(name);
    }

    // Remove from routing table
    if (config.topic_id != null) {
      this.ctx.routing.unregister(config.topic_id);
    }

    // Remove from fleet config and save
    delete this.ctx.fleetConfig!.instances[name];
    this.ctx.saveFleetConfig();

    this.ctx.logger.info({ name }, "Instance removed");
  }

  /** Handle create_instance tool call from a daemon. */
  async handleCreate(
    args: Record<string, unknown>,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const rawDirectory = args.directory as string | undefined;
    const directory = rawDirectory ? rawDirectory.replace(/^~/, process.env.HOME || "~") : undefined;
    const topicName = (args.topic_name as string) || (directory ? basename(directory) : undefined);
    const description = args.description as string | undefined;
    const systemPrompt = args.systemPrompt as string | undefined;
    const branch = args.branch as string | undefined;
    const detach = (args.detach as boolean) ?? false;

    if (!directory && !topicName) {
      respond(null, "topic_name is required when directory is not specified");
      return;
    }

    // Validate directory exists (only when explicitly provided)
    if (directory) {
      try {
        await access(directory);
      } catch {
        respond(null, `Directory does not exist: ${directory}`);
        return;
      }
    }

    // Enforce project_roots boundary when configured.
    // Note: uses path.resolve() (string normalization), not fs.realpathSync(),
    // so symlinks are not resolved — known limitation.
    const roots = this.ctx.fleetConfig?.project_roots;
    if (directory && roots?.length) {
      const resolved = resolve(directory);
      const allowed = roots.some(r => {
        const root = resolve(r.replace(/^~/, process.env.HOME || "~"));
        return resolved === root || resolved.startsWith(root + "/");
      });
      if (!allowed) {
        respond(null, `Directory "${directory}" is not under project_roots. Allowed: ${roots.join(", ")}`);
        return;
      }
    }

    // Check for duplicate early (before worktree creation) — only when directory is known and no branch
    if (directory && !branch) {
      const expandHome = (p: string) => p.replace(/^~/, process.env.HOME || "~");
      const existingInstance = Object.entries(this.ctx.fleetConfig?.instances ?? {})
        .find(([_, config]) => expandHome(config.working_directory) === directory);
      if (existingInstance) {
        const [eName, eConfig] = existingInstance;
        respond({
          success: true,
          status: "already_exists",
          name: eName,
          topic_id: eConfig.topic_id,
          running: this.daemons.has(eName),
        });
        return;
      }
    }

    // If branch specified, create git worktree (requires directory)
    let workDir = directory ?? "";
    let worktreePath: string | undefined;
    if (branch && !directory) {
      respond(null, "directory is required when branch is specified");
      return;
    }
    if (branch) {
      try {
        const { execFile: execFileCb } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const execFileAsync = promisify(execFileCb);

        await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: directory });

        const customPath = args.worktree_path as string | undefined;
        if (customPath) {
          worktreePath = customPath.replace(/^~/, process.env.HOME || "~");
        } else {
          const repoName = basename(directory!);
          const safeBranch = branch.replace(/\//g, "-");
          worktreePath = join(dirname(directory!), `${repoName}-${safeBranch}`);
        }

        let branchExists = false;
        try {
          await execFileAsync("git", ["rev-parse", "--verify", branch], { cwd: directory });
          branchExists = true;
        } catch { /* branch doesn't exist */ }

        if (detach) {
          await execFileAsync("git", ["worktree", "add", "--detach", worktreePath, branch], { cwd: directory });
        } else if (branchExists) {
          await execFileAsync("git", ["worktree", "add", worktreePath, branch], { cwd: directory });
        } else {
          await execFileAsync("git", ["worktree", "add", worktreePath, "-b", branch], { cwd: directory });
        }
        this.ctx.logger.info({ worktreePath, branch, repo: directory }, "Created git worktree for instance");
        workDir = worktreePath;
      } catch (err) {
        respond(null, `Failed to create worktree: ${(err as Error).message}`);
        return;
      }
    }

    // Check worktree path for duplicates
    if (worktreePath) {
      const expandHome = (p: string) => p.replace(/^~/, process.env.HOME || "~");
      const existingInstance = Object.entries(this.ctx.fleetConfig?.instances ?? {})
        .find(([_, config]) => expandHome(config.working_directory) === workDir);
      if (existingInstance) {
        const [eName, eConfig] = existingInstance;
        respond({
          success: true,
          status: "already_exists",
          name: eName,
          topic_id: eConfig.topic_id,
          running: this.daemons.has(eName),
        });
        return;
      }
    }

    // Sequential steps with rollback
    let createdTopicId: number | string | undefined;
    let newInstanceName: string | undefined;

    try {
      createdTopicId = await this.ctx.createForumTopic(topicName!);

      const nameBase = worktreePath ? topicName! : (directory ? basename(workDir) : topicName!);
      newInstanceName = `${sanitizeInstanceName(nameBase)}-t${createdTopicId}`;

      // If no directory was provided, auto-create default workspace
      if (!directory) {
        workDir = join(homedir(), ".agend", "workspaces", newInstanceName);
        mkdirSync(workDir, { recursive: true });
      }

      const instanceConfig = {
        ...DEFAULT_INSTANCE_CONFIG,
        ...this.ctx.fleetConfig!.defaults,
        working_directory: workDir,
        topic_id: createdTopicId,
        ...(description ? { description } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(args.model ? { model: args.model as string } : {}),
        ...(args.backend ? { backend: args.backend as string } : {}),
        ...(worktreePath ? { worktree_source: directory } : {}),
      } as InstanceConfig;
      this.ctx.fleetConfig!.instances[newInstanceName] = instanceConfig;
      this.ctx.routing.register(createdTopicId, { kind: "instance", name: newInstanceName });
      this.ctx.saveFleetConfig();

      await this.start(newInstanceName, instanceConfig, true);
      await this.ctx.connectIpcToInstance(newInstanceName);

      respond({
        success: true,
        name: newInstanceName,
        topic_id: createdTopicId,
        ...(worktreePath ? { worktree_path: worktreePath, branch } : {}),
      });
    } catch (err) {
      // Rollback in reverse order
      if (newInstanceName && this.daemons.has(newInstanceName)) {
        await this.stop(newInstanceName).catch(e => this.ctx.logger.error({ err: e, name: newInstanceName }, "Failed to stop instance during rollback"));
      }
      if (newInstanceName && this.ctx.fleetConfig?.instances[newInstanceName]) {
        delete this.ctx.fleetConfig.instances[newInstanceName];
        if (createdTopicId) this.ctx.routing.unregister(createdTopicId);
        this.ctx.saveFleetConfig();
      }
      if (createdTopicId) {
        await this.ctx.deleteForumTopic(createdTopicId);
      }
      if (worktreePath) {
        try {
          const { execFile: execFileCb } = await import("node:child_process");
          const { promisify } = await import("node:util");
          const execFileAsync = promisify(execFileCb);
          await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd: directory });
          await execFileAsync("git", ["worktree", "prune"], { cwd: directory });
        } catch { /* best-effort worktree cleanup */ }
      } else if (!directory && workDir) {
        // Remove auto-created workspace directory
        try {
          const { rm } = await import("node:fs/promises");
          await rm(workDir, { recursive: true, force: true });
        } catch { /* best-effort cleanup */ }
      }
      respond(null, `Failed to create instance: ${(err as Error).message}`);
    }
  }

  /** Handle delete_instance tool call from a daemon. */
  async handleDelete(
    args: Record<string, unknown>,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const instanceName = args.name as string;
    const deleteTopic = (args.delete_topic as boolean) ?? false;

    const instanceConfig = this.ctx.fleetConfig?.instances[instanceName];
    if (!instanceConfig) {
      respond(null, `Instance not found: ${instanceName}`);
      return;
    }

    if (instanceConfig.general_topic) {
      respond(null, "Cannot delete the General instance");
      return;
    }

    if (deleteTopic && instanceConfig.topic_id) {
      await this.ctx.deleteForumTopic(instanceConfig.topic_id);
    }

    await this.ctx.removeInstance(instanceName);
    respond({ success: true, name: instanceName, topic_deleted: deleteTopic });
  }

  has(name: string): boolean {
    return this.daemons.has(name);
  }

  private findGeneralInstance(): string | undefined {
    const instances = this.ctx.fleetConfig?.instances ?? {};
    for (const [n, config] of Object.entries(instances)) {
      if (config.general_topic) return n;
    }
    return undefined;
  }
}
