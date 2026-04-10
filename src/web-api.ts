/**
 * Web UI HTTP API handler.
 * All /ui/* routes are handled here, extracted from fleet-manager.ts.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Minimal interface — only what web-api needs from FleetManager. */
export interface WebApiContext {
  readonly webToken: string | null;
  readonly dataDir: string;
  readonly sseClients: Set<ServerResponse>;
  readonly fleetConfig: {
    channel?: { group_id?: number | string; mode?: string };
    instances: Record<string, { topic_id?: number | string; working_directory: string; description?: string; display_name?: string }>;
    teams?: Record<string, { members: string[]; description?: string }>;
  } | null;
  readonly instanceIpcClients: Map<string, { send(msg: unknown): void }>;
  readonly adapter: { sendText(chatId: string, text: string, opts?: { threadId?: string }): Promise<unknown> } | null;
  readonly daemons: Map<string, unknown>;
  readonly eventLog: { logActivity(event: string, sender: string, summary: string, receiver?: string, detail?: string): void; listActivity(opts?: { since?: string; limit?: number }): unknown[] } | null;
  readonly logger: { info(obj: unknown, msg?: string): void; debug(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
  getInstanceDir(name: string): string;
  getInstanceStatus(name: string): "running" | "stopped" | "crashed";
  getUiStatus(): unknown;
  emitSseEvent(event: string, data: unknown): void;
  startInstance(name: string, config: unknown, topicMode: boolean): Promise<void>;
  stopInstance(name: string): Promise<void>;
  restartSingleInstance(name: string): Promise<void>;
  removeInstance(name: string): Promise<void>;
  lastInboundUser: Map<string, string>;
  saveFleetConfig(): void;
  readonly lifecycle: { handleCreate(args: Record<string, unknown>, respond: (result: unknown, error?: string) => void): Promise<void> };
  connectIpcToInstance(name: string): Promise<void>;
  readonly scheduler: {
    db: {
      listTasks(opts?: { assignee?: string; status?: string }): unknown[];
      createTask(params: { title: string; description?: string; priority?: string; assignee?: string; created_by: string }): unknown;
      updateTask(id: string, params: Record<string, unknown>): unknown;
      claimTask(id: string, assignee: string): unknown;
      completeTask(id: string, result?: string): unknown;
    };
    list(target?: string): unknown[];
    create(params: unknown): unknown;
    delete(id: string): void;
  } | null;
}

/** Parse JSON body from request. */
function parseBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

/** Send JSON response. */
function json(res: ServerResponse, status: number, data: unknown): void {
  res.setHeader("Content-Type", "application/json");
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

/**
 * Handle a Web UI request. Returns true if handled, false to pass through.
 */
export function handleWebRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: WebApiContext,
): boolean {
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Auth check for all /ui routes
  if (path.startsWith("/ui")) {
    const token = url.searchParams.get("token");
    if (token !== ctx.webToken) {
      json(res, 401, { error: "Unauthorized" });
      return true;
    }
  } else {
    return false;
  }

  // ── Static files ───────────────────────────────────────

  if (method === "GET" && path === "/ui") {
    try {
      const html = readFileSync(join(__dirname, "ui", "dashboard.html"), "utf-8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.writeHead(200);
      res.end(html);
    } catch {
      json(res, 500, { error: "dashboard.html not found" });
    }
    return true;
  }

  // Serve JS modules
  if (method === "GET" && path.startsWith("/ui/js/")) {
    const fileName = path.slice("/ui/js/".length);
    if (!/^[a-z0-9_-]+\.js$/.test(fileName)) {
      json(res, 400, { error: "Invalid file name" });
      return true;
    }
    try {
      const js = readFileSync(join(__dirname, "ui", fileName), "utf-8");
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.writeHead(200);
      res.end(js);
    } catch {
      json(res, 404, { error: "File not found" });
    }
    return true;
  }

  // ── Backend detection ─────────────────────────────────

  if (method === "GET" && path === "/ui/backends") {
    const BACKENDS = [
      { name: "claude-code", binary: "claude" },
      { name: "codex", binary: "codex" },
      { name: "gemini-cli", binary: "gemini" },
      { name: "opencode", binary: "opencode" },
      { name: "kiro-cli", binary: "kiro-cli" },
    ];
    const backends = BACKENDS.map(b => {
      let installed = false;
      let binPath = "";
      try { binPath = execSync(`which ${b.binary}`, { stdio: "pipe" }).toString().trim(); installed = true; } catch { /* */ }
      return { name: b.name, binary: b.binary, installed, path: binPath };
    });
    json(res, 200, { backends });
    return true;
  }

  // ── SSE ────────────────────────────────────────────────

  if (method === "GET" && path === "/ui/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`event: status\ndata: ${JSON.stringify(ctx.getUiStatus())}\n\n`);
    ctx.sseClients.add(res);
    req.on("close", () => ctx.sseClients.delete(res));
    const interval = setInterval(() => {
      res.write(`event: status\ndata: ${JSON.stringify(ctx.getUiStatus())}\n\n`);
    }, 10_000);
    req.on("close", () => clearInterval(interval));
    return true;
  }

  // ── Send message ───────────────────────────────────────

  if (method === "POST" && path === "/ui/send") {
    handleSendMessage(req, res, ctx);
    return true;
  }

  // ── Instance operations ────────────────────────────────

  const stopMatch = path.match(/^\/ui\/stop\/(.+)$/);
  if (method === "POST" && stopMatch) {
    const name = decodeURIComponent(stopMatch[1]);
    if (!ctx.fleetConfig?.instances[name]) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    (async () => {
      try {
        await ctx.stopInstance(name);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { stopped: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const startMatch = path.match(/^\/ui\/start\/(.+)$/);
  if (method === "POST" && startMatch) {
    const name = decodeURIComponent(startMatch[1]);
    const config = ctx.fleetConfig?.instances[name];
    if (!config) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    const topicMode = ctx.fleetConfig?.channel?.mode === "topic";
    (async () => {
      try {
        await ctx.startInstance(name, config, topicMode ?? false);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { started: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const deleteMatch = path.match(/^\/ui\/instances\/(.+)\/delete$/);
  if (method === "POST" && deleteMatch) {
    const name = decodeURIComponent(deleteMatch[1]);
    if (!ctx.fleetConfig?.instances[name]) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    (async () => {
      try {
        const body = await parseBody(req);
        if (body.confirm !== `delete ${name}`) {
          json(res, 400, { error: `Confirmation required: { "confirm": "delete ${name}" }` });
          return;
        }
        await ctx.removeInstance(name);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { deleted: name });
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Instance detail ────────────────────────────────────

  const detailMatch = path.match(/^\/ui\/instance\/(.+)$/);
  if (method === "GET" && detailMatch) {
    const name = decodeURIComponent(detailMatch[1]);
    const config = ctx.fleetConfig?.instances[name];
    if (!config) {
      json(res, 404, { error: `Instance not found: ${name}` });
      return true;
    }
    const statusFile = join(ctx.getInstanceDir(name), "statusline.json");
    let statusline: Record<string, unknown> = {};
    try { statusline = JSON.parse(readFileSync(statusFile, "utf-8")); } catch { /* */ }

    const activity = ctx.eventLog?.listActivity({ since: new Date(Date.now() - 3600_000).toISOString(), limit: 50 }) ?? [];
    const instanceActivity = (activity as { sender?: string; receiver?: string }[]).filter(
      a => a.sender === name || a.receiver === name,
    );

    json(res, 200, {
      name,
      status: ctx.getInstanceStatus(name),
      description: config.description,
      display_name: config.display_name,
      working_directory: config.working_directory,
      statusline,
      recent_activity: instanceActivity.slice(0, 20),
    });
    return true;
  }

  // ── Restart (with auth — unifies /restart/:name) ─────

  const restartMatch = path.match(/^\/ui\/restart\/(.+)$/);
  if (method === "POST" && restartMatch) {
    const name = decodeURIComponent(restartMatch[1]);
    (async () => {
      try {
        await ctx.restartSingleInstance(name);
        ctx.emitSseEvent("status", ctx.getUiStatus());
        json(res, 200, { restarted: name });
      } catch (err) {
        const status = (err as Error).message.includes("not found") ? 404 : 500;
        json(res, status, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Create instance ────────────────────────────────────

  if (method === "POST" && path === "/ui/instances") {
    (async () => {
      try {
        const body = await parseBody(req);
        let result: unknown = null;
        let error: string | undefined;
        await ctx.lifecycle.handleCreate(body, (r, e) => { result = r; error = e; });
        if (error) {
          json(res, 400, { error });
        } else {
          ctx.emitSseEvent("status", ctx.getUiStatus());
          json(res, 200, result);
        }
      } catch (err) {
        json(res, 500, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Task board ─────────────────────────────────────────

  if (method === "GET" && path === "/ui/tasks") {
    if (!ctx.scheduler) {
      json(res, 200, { tasks: [] });
      return true;
    }
    const tasks = ctx.scheduler.db.listTasks();
    json(res, 200, { tasks });
    return true;
  }

  if (method === "POST" && path === "/ui/tasks") {
    if (!ctx.scheduler) {
      json(res, 500, { error: "Scheduler not initialized" });
      return true;
    }
    (async () => {
      try {
        const body = await parseBody(req);
        const task = ctx.scheduler!.db.createTask({
          title: body.title as string,
          description: body.description as string | undefined,
          priority: body.priority as string | undefined,
          assignee: body.assignee as string | undefined,
          created_by: "web-user",
        });
        json(res, 200, task);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    })();
    return true;
  }

  const taskMatch = path.match(/^\/ui\/tasks\/(.+)$/);
  if (method === "POST" && taskMatch) {
    if (!ctx.scheduler) {
      json(res, 500, { error: "Scheduler not initialized" });
      return true;
    }
    const id = decodeURIComponent(taskMatch[1]);
    (async () => {
      try {
        const body = await parseBody(req);
        const action = body.action as string;
        let result: unknown;
        if (action === "claim") {
          result = ctx.scheduler!.db.claimTask(id, (body.assignee as string) || "web-user");
        } else if (action === "complete") {
          result = ctx.scheduler!.db.completeTask(id, body.result as string | undefined);
        } else {
          result = ctx.scheduler!.db.updateTask(id, body);
        }
        json(res, 200, result);
      } catch (err) {
        json(res, 400, { error: (err as Error).message });
      }
    })();
    return true;
  }

  // ── Schedules ───────────────────────────────────────────

  if (method === "GET" && path === "/ui/schedules") {
    if (!ctx.scheduler) { json(res, 200, { schedules: [] }); return true; }
    json(res, 200, { schedules: ctx.scheduler.list() });
    return true;
  }

  if (method === "POST" && path === "/ui/schedules") {
    if (!ctx.scheduler) { json(res, 500, { error: "Scheduler not initialized" }); return true; }
    (async () => {
      try {
        const body = await parseBody(req);
        const schedule = ctx.scheduler!.create(body);
        json(res, 200, schedule);
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  const schedDelMatch = path.match(/^\/ui\/schedules\/(.+)$/);
  if (method === "DELETE" && schedDelMatch) {
    if (!ctx.scheduler) { json(res, 500, { error: "Scheduler not initialized" }); return true; }
    try {
      ctx.scheduler.delete(decodeURIComponent(schedDelMatch[1]));
      json(res, 200, { deleted: true });
    } catch (err) { json(res, 400, { error: (err as Error).message }); }
    return true;
  }

  // ── Teams ──────────────────────────────────────────────

  if (method === "GET" && path === "/ui/teams") {
    const teams = ctx.fleetConfig?.teams ?? {};
    json(res, 200, { teams });
    return true;
  }

  if (method === "POST" && path === "/ui/teams") {
    (async () => {
      try {
        const body = await parseBody(req);
        const name = body.name as string;
        const members = body.members as string[];
        const description = body.description as string | undefined;
        if (!name || !members?.length) { json(res, 400, { error: "name and members required" }); return; }
        if (!ctx.fleetConfig) { json(res, 500, { error: "No fleet config" }); return; }
        if (!ctx.fleetConfig.teams) (ctx.fleetConfig as { teams: Record<string, unknown> }).teams = {};
        (ctx.fleetConfig.teams as Record<string, unknown>)[name] = { members, description };
        ctx.saveFleetConfig();
        json(res, 200, { created: name });
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  const teamDelMatch = path.match(/^\/ui\/teams\/(.+)$/);
  if (method === "DELETE" && teamDelMatch) {
    const name = decodeURIComponent(teamDelMatch[1]);
    if (!ctx.fleetConfig?.teams?.[name]) { json(res, 404, { error: `Team not found: ${name}` }); return true; }
    delete (ctx.fleetConfig.teams as Record<string, unknown>)[name];
    ctx.saveFleetConfig();
    json(res, 200, { deleted: name });
    return true;
  }

  // ── Fleet config (read-only, sanitized) ────────────────

  if (method === "GET" && path === "/ui/config") {
    const config = ctx.fleetConfig;
    if (!config) { json(res, 200, {}); return true; }
    const ch = config.channel as Record<string, unknown> | undefined;
    const defaults = (config as Record<string, unknown>).defaults as Record<string, unknown> | undefined;
    json(res, 200, {
      channel: ch ? {
        type: ch.type, mode: config.channel!.mode,
        bot_token_env: ch.bot_token_env,
        group_id: config.channel!.group_id,
        access: ch.access,
      } : undefined,
      defaults: defaults ? { backend: defaults.backend, model: defaults.model } : undefined,
      project_roots: (config as Record<string, unknown>).project_roots,
      health_port: (config as Record<string, unknown>).health_port,
    });
    return true;
  }

  if (method === "POST" && path === "/ui/config") {
    (async () => {
      try {
        const body = await parseBody(req);
        const config = ctx.fleetConfig;
        if (!config) { json(res, 500, { error: "No fleet config" }); return; }
        const ch = config.channel as Record<string, unknown> | undefined;
        // Update channel settings
        if (body.channel && ch) {
          const update = body.channel as Record<string, unknown>;
          if (update.group_id != null) (config.channel as Record<string, unknown>).group_id = update.group_id;
          if (update.access) (config.channel as Record<string, unknown>).access = update.access;
        }
        // Update defaults
        if (body.defaults) {
          const d = (config as Record<string, unknown>).defaults as Record<string, unknown>;
          const upd = body.defaults as Record<string, unknown>;
          if (upd.backend) d.backend = upd.backend;
          if (upd.model) d.model = upd.model;
        }
        // Update project_roots
        if (body.project_roots) {
          (config as Record<string, unknown>).project_roots = body.project_roots;
        }
        ctx.saveFleetConfig();
        const needsRestart = !!(body.channel as Record<string, unknown>)?.group_id;
        json(res, 200, { saved: true, needs_restart: needsRestart });
      } catch (err) { json(res, 400, { error: (err as Error).message }); }
    })();
    return true;
  }

  // Not handled
  json(res, 404, { error: "not found" });
  return true;
}

/** Handle POST /ui/send — extracted for readability. */
function handleSendMessage(req: IncomingMessage, res: ServerResponse, ctx: WebApiContext): void {
  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
  req.on("end", () => {
    try {
      const { instance, message } = JSON.parse(body) as { instance: string; message: string };
      const ipc = ctx.instanceIpcClients.get(instance);
      if (!ipc) {
        json(res, 404, { error: `Instance not found: ${instance}` });
        return;
      }
      const ts = new Date().toISOString();
      // Use real Telegram context so daemon's lastChatId/lastThreadId are set,
      // enabling reply tool even when first message comes from Web UI.
      // Pure Web UI mode (no channel config) leaves these empty — TODO: needs
      // a separate reply path for that case.
      const groupId = ctx.fleetConfig?.channel?.group_id;
      const topicId = ctx.fleetConfig?.instances[instance]?.topic_id;
      ipc.send({
        type: "fleet_inbound",
        content: message,
        targetSession: instance,
        meta: {
          chat_id: groupId ? String(groupId) : "",
          message_id: `web-${Date.now()}`,
          user: "web-user", user_id: "web-user",
          ts,
          thread_id: topicId != null ? String(topicId) : "",
          source: "web",
        },
      });
      ctx.lastInboundUser.set(instance, "web-user");
      ctx.eventLog?.logActivity("message", "web-user", message.slice(0, 200), instance);
      ctx.emitSseEvent("message", { instance, sender: "web-user", text: message, ts });
      // Sync to Telegram
      if (ctx.adapter && ctx.fleetConfig?.channel?.group_id) {
        const topicId = ctx.fleetConfig.instances[instance]?.topic_id;
        const preview = message.length > 500 ? message.slice(0, 500) + " [...]" : message;
        ctx.adapter.sendText(
          String(ctx.fleetConfig.channel.group_id),
          `🌐 web-user: ${preview}`,
          { threadId: topicId != null ? String(topicId) : undefined },
        ).catch(e => ctx.logger.debug({ err: e }, "Web→Telegram sync failed"));
      }
      json(res, 200, { sent: true });
    } catch {
      json(res, 400, { error: "Invalid JSON" });
    }
  });
}
