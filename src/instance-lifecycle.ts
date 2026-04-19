import { existsSync, readFileSync, mkdirSync, realpathSync } from "node:fs";
import { join, basename, dirname, resolve, sep as pathSep } from "node:path";
import { access, unlink } from "node:fs/promises";
import { getAgendHome } from "./paths.js";
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
  /** List claimed tasks for an instance (from task board). Returns empty array if unavailable. */
  listClaimedTasks(assignee: string): Array<{ id: string; title: string }>;
  webhookEmit(event: string, name: string, data?: Record<string, unknown>): void;
  checkModelFailover(name: string, fiveHourPct: number): void;
  startStatuslineWatcher(name: string): void;
}

type Daemon = InstanceType<typeof import("./daemon.js").Daemon>;

/** Arguments accepted by handleCreate — mirrors CreateInstanceArgs in outbound-schemas.ts
 *  plus internal-only fields forwarded by deploy_template (profile-derived). */
export interface LifecycleCreateArgs {
  directory?: string;
  topic_name?: string;
  description?: string;
  model?: string;
  backend?: string;
  branch?: string;
  detach?: boolean;
  worktree_path?: string;
  systemPrompt?: string;
  tags?: string[];
  workflow?: string | false;
  model_failover?: string[];
  tool_set?: string;
  skipPermissions?: boolean;
  lightweight?: boolean;
  /** Internal: used by deploy_template when branch is specified to base a new branch off this ref. */
  start_point?: string;
  /** Preserve any other passthrough keys without loss. */
  [key: string]: unknown;
}

export interface LifecycleDeleteArgs {
  name: string;
  delete_topic?: boolean;
}

export interface LifecycleReplaceArgs {
  name: string;
  reason?: string;
}

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

    // Defense-in-depth: clear crash state before daemon start
    try { await unlink(join(instanceDir, "crash-state.json")); } catch {}

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

    const hangDetector = daemon.getHangDetector();
    if (hangDetector) {
      hangDetector.on("hang", safeHandler(async () => {
        this.ctx.eventLog?.insert(name, "hang_detected", {});
        this.ctx.logger.warn({ name }, "Instance appears hung");

        // Check if instance has claimed tasks — nudge it to continue
        const claimedTasks = this.ctx.listClaimedTasks(name);
        if (claimedTasks.length > 0) {
          const task = claimedTasks[0];
          this.ctx.eventLog?.insert(name, "idle_task_nudge", { taskId: task.id, taskTitle: task.title });
          // Inject nudge message into the instance's CLI session
          const ipc = this.ctx.instanceIpcClients.get(name);
          if (ipc?.connected) {
            ipc.send({
              type: "fleet_inbound",
              content: `[system] You have a claimed task: "${task.title}" (#${task.id}). Continue working on it, or use task(done) / task(update, status=blocked) to update status.`,
              meta: { chat_id: "", thread_id: "", ts: new Date().toISOString() },
            });
          }
        }

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
      const instanceDir = this.ctx.getInstanceDir(name);
      const pidPath = join(instanceDir, "daemon.pid");
      if (existsSync(pidPath)) {
        const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
        try { process.kill(pid, "SIGTERM"); } catch (e) { this.ctx.logger.debug({ err: e, pid }, "SIGTERM failed for stale process"); }
      }
      // Kill orphaned tmux window (daemon not in memory but window may persist)
      const windowIdPath = join(instanceDir, "window-id");
      if (existsSync(windowIdPath)) {
        const windowId = readFileSync(windowIdPath, "utf-8").trim();
        if (windowId) {
          const { TmuxManager } = await import("./tmux-manager.js");
          const { getTmuxSession } = await import("./config.js");
          const tmux = new TmuxManager(getTmuxSession(), windowId);
          await tmux.killWindow();
        }
        try { const { unlinkSync } = await import("node:fs"); unlinkSync(windowIdPath); } catch {}
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

    // Stop daemon and clean up tmux window (handles both in-memory and orphaned cases)
    await this.stop(name);

    // Clean up backend config files (MCP config, instructions, etc.)
    // This is needed even when daemon is not in memory — stop() only calls
    // backend.cleanup() when daemon object exists. Without this, stale MCP
    // entries remain in the working directory and crash new instances.
    if (config.working_directory && config.backend) {
      try {
        const { createBackend } = await import("./backend/factory.js");
        const instanceDir = this.ctx.getInstanceDir(name);
        const backend = createBackend(config.backend, instanceDir);
        if (backend?.cleanup) {
          const backendConfig = {
            workingDirectory: config.working_directory,
            instanceDir,
            instanceName: name,
            mcpServers: {
              agend: { command: "", args: [], env: {} },
            },
          };
          backend.cleanup(backendConfig as import("./backend/types.js").CliBackendConfig);
          this.ctx.logger.info({ name }, "Cleaned up backend config files");
        }
      } catch (err) {
        this.ctx.logger.debug({ err, name }, "Backend cleanup failed (best effort)");
      }
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
        } catch {
          // worktree remove failed — directory exists but isn't a valid worktree.
          // Only rm if directory is in the expected location (sibling of source repo or under ~/.agend/).
          const expectedParent = dirname(config.working_directory);
          const sourceParent = dirname(config.worktree_source);
          if (expectedParent === sourceParent || config.working_directory.startsWith(getAgendHome())) {
            const { rm } = await import("node:fs/promises");
            await rm(config.working_directory, { recursive: true, force: true });
            this.ctx.logger.info({ worktree: config.working_directory }, "Removed orphaned worktree directory");
          } else {
            this.ctx.logger.warn({ worktree: config.working_directory }, "Worktree removal failed and directory is outside expected location — skipping rm");
          }
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
    args: LifecycleCreateArgs,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const rawDirectory = args.directory;
    const directory = rawDirectory ? rawDirectory.replace(/^~/, process.env.HOME || "~") : undefined;
    const topicName = args.topic_name || (directory ? basename(directory) : undefined);
    const description = args.description;
    const systemPrompt = args.systemPrompt;
    const branch = args.branch;
    const detach = args.detach ?? false;

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

    // Enforce project_roots boundary when configured. Use realpathSync so
    // symlinks cannot be used to escape the allowed roots (a directory under
    // an allowed root that symlinks to `/etc` would otherwise pass the string
    // prefix check).
    const roots = this.ctx.fleetConfig?.project_roots;
    if (directory && roots?.length) {
      let resolved: string;
      try {
        resolved = realpathSync(resolve(directory));
      } catch {
        respond(null, `Directory "${directory}" is not accessible`);
        return;
      }
      const allowed = roots.some(r => {
        const raw = resolve(r.replace(/^~/, process.env.HOME || "~"));
        let root: string;
        try {
          root = realpathSync(raw);
        } catch {
          // Root doesn't exist on disk — cannot be a valid boundary.
          return false;
        }
        return resolved === root || resolved.startsWith(root + pathSep);
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

        const customPath = args.worktree_path;
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
          const startPoint = args.start_point;
          const worktreeArgs = ["worktree", "add", worktreePath, "-b", branch];
          if (startPoint) worktreeArgs.push(startPoint);
          await execFileAsync("git", worktreeArgs, { cwd: directory });
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

      // Use explicit topic_name as name base when provided; fall back to directory basename
      const explicitTopicName = args.topic_name;
      const nameBase = explicitTopicName ?? (worktreePath ? topicName! : (directory ? basename(workDir) : topicName!));
      newInstanceName = `${sanitizeInstanceName(nameBase)}-t${createdTopicId}`;

      // If no directory was provided, auto-create default workspace
      if (!directory) {
        workDir = join(getAgendHome(), "workspaces", newInstanceName);
        mkdirSync(workDir, { recursive: true });
      }

      const instanceConfig = {
        ...DEFAULT_INSTANCE_CONFIG,
        ...this.ctx.fleetConfig!.defaults,
        working_directory: workDir,
        topic_id: createdTopicId,
        ...(description ? { description } : {}),
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(args.model ? { model: args.model } : {}),
        ...(args.backend ? { backend: args.backend } : {}),
        ...(args.model_failover ? { model_failover: args.model_failover } : {}),
        ...(args.tool_set ? { tool_set: args.tool_set } : {}),
        ...(args.skipPermissions != null ? { skipPermissions: args.skipPermissions } : {}),
        ...(args.lightweight != null ? { lightweight: args.lightweight } : {}),
        ...(args.workflow !== undefined ? { workflow: args.workflow === "false" ? false : args.workflow } : {}),
        ...(args.tags ? { tags: args.tags } : {}),
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
    args: LifecycleDeleteArgs,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const instanceName = args.name;
    const deleteTopic = args.delete_topic ?? false;

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

  /** Handle replace_instance tool call: handover → stop → create new → delete old config.
   *  If the old instance has a worktree_source, ownership transfers to the new instance
   *  implicitly via savedConfig — the worktree itself is not recreated or removed. */
  async handleReplace(
    args: LifecycleReplaceArgs,
    respond: (result: unknown, error?: string) => void,
  ): Promise<void> {
    const instanceName = args.name;
    const reason = args.reason || "replaced";

    const oldConfig = this.ctx.fleetConfig?.instances[instanceName];
    if (!oldConfig) { respond(null, `Instance not found: ${instanceName}`); return; }
    if (oldConfig.general_topic) { respond(null, "Cannot replace the General instance"); return; }

    // 1. Collect handover context from daemon ring buffer (before stopping)
    let handoverContext = "";
    const daemon = this.daemons.get(instanceName);
    if (daemon) {
      handoverContext = daemon.collectHandoverContext();
    }

    // 2. Remember config for recreation
    const savedConfig = { ...oldConfig };
    const topicId = savedConfig.topic_id;

    // 3. Stop old instance (reversible — config still in fleet.yaml)
    await this.stop(instanceName);
    const oldIpc = this.ctx.instanceIpcClients.get(instanceName);
    if (oldIpc) { await oldIpc.close(); this.ctx.instanceIpcClients.delete(instanceName); }

    // 4. Remove old config + routing (so new instance can reuse the name/topic)
    if (topicId != null) this.ctx.routing.unregister(topicId);
    delete this.ctx.fleetConfig!.instances[instanceName];
    this.ctx.saveFleetConfig();

    // 5. Clean instanceDir to avoid stale rotation-state.json / crash-history
    const instanceDir = this.ctx.getInstanceDir(instanceName);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(instanceDir, { recursive: true, force: true });
    } catch { /* best effort */ }

    // 6. Create new instance with same config, reusing topic
    const newName = `${instanceName.replace(/-t\d+$/, "")}-t${topicId}`;
    const instanceConfig = { ...savedConfig } as InstanceConfig;
    try {
      this.ctx.fleetConfig!.instances[newName] = instanceConfig;
      if (topicId != null) this.ctx.routing.register(topicId, { kind: "instance", name: newName });
      this.ctx.saveFleetConfig();

      await this.start(newName, instanceConfig, true);
      await this.ctx.connectIpcToInstance(newName);

      // 7. Send handover context via fleet_inbound (standard message delivery path)
      if (handoverContext) {
        await new Promise(r => setTimeout(r, 3_000));
        const newIpc = this.ctx.instanceIpcClients.get(newName);
        if (newIpc) {
          const handoverMsg = `[system:handover]\nYou are replacing instance "${instanceName}" (reason: ${reason}).\n\n${handoverContext}\n\nResume work based on this context. Do NOT reply to this message — wait for the next user message.`;
          newIpc.send({
            type: "fleet_inbound",
            content: handoverMsg,
            meta: { from_instance: "system", source: "handover", user: "system", ts: new Date().toISOString(), chat_id: "", thread_id: "" },
          });
        }
      }

      respond({
        success: true,
        old_name: instanceName,
        new_name: newName,
        topic_id: topicId,
        reason,
        handover_chars: handoverContext.length,
      });
    } catch (err) {
      // Rollback: restore old instance config (new instance failed to start)
      if (this.daemons.has(newName)) await this.stop(newName).catch(() => {});
      delete this.ctx.fleetConfig!.instances[newName];
      // Restore old config so user doesn't lose both instances
      this.ctx.fleetConfig!.instances[instanceName] = savedConfig;
      if (topicId != null) this.ctx.routing.register(topicId, { kind: "instance", name: instanceName });
      this.ctx.saveFleetConfig();
      respond(null, `Failed to replace instance: ${(err as Error).message}. Old instance config restored (stopped).`);
    }
  }

  private findGeneralInstance(): string | undefined {
    const instances = this.ctx.fleetConfig?.instances ?? {};
    for (const [n, config] of Object.entries(instances)) {
      if (config.general_topic) return n;
    }
    return undefined;
  }
}
