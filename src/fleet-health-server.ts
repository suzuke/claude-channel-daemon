/**
 * Health / dashboard HTTP server for the daemon.
 *
 * Exposes:
 *   - GET /health       (public, no auth)
 *   - GET /status       (basic per-instance snapshot)
 *   - GET /api/fleet    (enriched fleet snapshot for the UI)
 *   - GET /api/activity (event log entries; ?since= ?limit=)
 *   - GET /activity     (HTML viewer; served from fleet-dashboard-html.ts)
 *   - POST /api/instance/:name/start
 *   - POST /restart/:name
 *   - POST /agent       (forwarded to handleAgentRequest)
 *   - GET  /ui/*        (forwarded to handleWebRequest)
 *
 * All endpoints except /health require a Bearer / ?token= match against
 * the per-process web token written to <dataDir>/web.token (mode 0600).
 *
 * Extracted from fleet-manager.ts (P4.1 step 4 of 4).
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Logger } from "./logger.js";
import type { FleetConfig, InstanceConfig } from "./types.js";
import type { Scheduler } from "./scheduler/index.js";
import type { EventLog } from "./event-log.js";
import type { SysInfo } from "./fleet-context.js";
import { ACTIVITY_VIEWER_HTML } from "./fleet-dashboard-html.js";
import { handleAgentRequest, type AgentEndpointContext } from "./agent-endpoint.js";
import { handleWebRequest, type WebApiContext } from "./web-api.js";

/**
 * Extract a web token from a request, accepting (in order):
 *   1. `?token=` query string
 *   2. `Authorization: Bearer <token>` header (standard)
 *   3. `X-Agend-Token: <token>` header (legacy compatibility)
 */
export function extractWebToken(
  parsedUrl: URL,
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const queryToken = parsedUrl.searchParams.get("token");
  if (queryToken) return queryToken;

  const auth = headers["authorization"];
  const authStr = Array.isArray(auth) ? auth[0] : auth;
  if (authStr && /^Bearer\s+/i.test(authStr)) {
    return authStr.replace(/^Bearer\s+/i, "").trim();
  }

  const headerToken = headers["x-agend-token"];
  if (typeof headerToken === "string") return headerToken;
  if (Array.isArray(headerToken) && headerToken.length > 0) return headerToken[0];

  return null;
}

export interface UiStatusContext {
  readonly fleetConfig: FleetConfig | null;
  readonly logger: Logger;
  getInstanceDir(name: string): string;
  getInstanceStatus(name: string): "running" | "stopped" | "crashed";
}

export interface HealthServerContext extends UiStatusContext {
  readonly dataDir: string;
  readonly scheduler: Scheduler | null;
  readonly eventLog: EventLog | null;
  getSysInfo(): SysInfo;
  lastActivityMs(name: string): number;
  startInstance(name: string, config: InstanceConfig, topicMode: boolean): Promise<void>;
  restartSingleInstance(name: string): Promise<void>;
  emitSseEvent(event: string, data: unknown): void;
}

export function startHealthServer(ctx: HealthServerContext, port: number): { server: Server; webToken: string; startedAt: number } {
  let server: Server;
    const startedAt = Date.now();

    // Generate web token before server starts so auth is enforced from the first request.
    const webToken = randomBytes(24).toString("hex");
    const tokenPath = join(ctx.dataDir, "web.token");
    writeFileSync(tokenPath, webToken, { mode: 0o600 });
    // Defensive: if file existed previously with looser perms, tighten it.
    try {
      chmodSync(tokenPath, 0o600);
    } catch {
      // best-effort
    }

    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");

      // Public health probe — no auth required.
      if (req.method === "GET" && req.url === "/health") {
        // fallthrough to existing handler below
      } else {
        // All other endpoints require a valid token. Accepts ?token= query,
        // Authorization: Bearer <token>, or legacy X-Agend-Token header.
        // /ui/* will also re-check in web-api.ts, which is harmless.
        const parsedUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
        const providedToken = extractWebToken(parsedUrl, req.headers);
        if (!webToken || providedToken !== webToken) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
      }

      if (req.method === "GET" && req.url === "/health") {
        const instanceCount = ctx.fleetConfig?.instances
          ? Object.keys(ctx.fleetConfig.instances).length
          : 0;
        res.writeHead(200);
        res.end(JSON.stringify({
          status: "ok",
          instances: instanceCount,
          uptime: Math.floor((Date.now() - startedAt) / 1000),
        }));
        return;
      }

      if (req.method === "GET" && req.url === "/status") {
        const instances = Object.keys(ctx.fleetConfig?.instances ?? {}).map(name => {
          const statusFile = join(ctx.getInstanceDir(name), "statusline.json");
          let context_pct = 0;
          let cost = 0;
          try {
            const data = JSON.parse(readFileSync(statusFile, "utf-8"));
            context_pct = data.context_window?.used_percentage ?? 0;
            cost = data.cost?.total_cost_usd ?? 0;
          } catch (err) {
            ctx.logger.debug({ err, name }, "statusline.json read failed (/status)");
          }
          return {
            name,
            status: ctx.getInstanceStatus(name),
            context_pct,
            cost,
          };
        });
        res.writeHead(200);
        res.end(JSON.stringify({ instances }));
        return;
      }

      // Fleet API (enriched for agent board)
      if (req.method === "GET" && req.url === "/api/fleet") {
        const sysInfo = ctx.getSysInfo();
        const enriched = sysInfo.instances.map(inst => {
          const config = ctx.fleetConfig?.instances[inst.name];
          // Find claimed tasks for this instance
          let currentTask: string | null = null;
          try {
            const tasks = ctx.scheduler?.db.listTasks({ assignee: inst.name, status: "claimed" });
            if (tasks?.length) currentTask = tasks[0].title;
          } catch (err) {
            ctx.logger.debug({ err, name: inst.name }, "Scheduler listTasks failed (/api/fleet)");
          }
          return {
            ...inst,
            description: config?.description ?? null,
            backend: config?.backend ?? "claude-code",
            tool_set: config?.tool_set ?? "full",
            general_topic: config?.general_topic ?? false,
            lastActivity: ctx.lastActivityMs(inst.name) || null,
            currentTask,
          };
        });
        // Same-origin only — token-bearing requests come from the dashboard
        // served by this same daemon, so no CORS allowance is needed.
        res.writeHead(200);
        res.end(JSON.stringify({
          ...sysInfo,
          instances: enriched,
        }));
        return;
      }

      // Activity API
      if (req.method === "GET" && req.url?.startsWith("/api/activity")) {
        const url = new URL(req.url, `http://localhost:${port}`);
        const sinceParam = url.searchParams.get("since") ?? "2h";
        const limitParam = url.searchParams.get("limit") ?? "500";

        const match = sinceParam.match(/^(\d+)(m|h|d)$/);
        let sinceIso: string | undefined;
        if (match) {
          const val = parseInt(match[1], 10);
          const unit = match[2] === "d" ? 86400000 : match[2] === "h" ? 3600000 : 60000;
          sinceIso = new Date(Date.now() - val * unit).toISOString();
        }

        const rows = ctx.eventLog?.listActivity({ since: sinceIso, limit: parseInt(limitParam, 10) }) ?? [];
        // Same-origin only — see /api/fleet rationale.
        res.writeHead(200);
        res.end(JSON.stringify(rows));
        return;
      }

      // Activity viewer
      if (req.method === "GET" && (req.url === "/activity" || req.url === "/activity/")) {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end(ACTIVITY_VIEWER_HTML);
        return;
      }

      // Instance start via API
      if (req.method === "POST" && req.url?.startsWith("/api/instance/") && req.url.endsWith("/start")) {
        const name = decodeURIComponent(req.url.slice("/api/instance/".length, -"/start".length));
        const config = ctx.fleetConfig?.instances[name];
        if (!config) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `Instance not found: ${name}` }));
          return;
        }
        (async () => {
          try {
            const topicMode = ctx.fleetConfig?.channel?.mode === "topic";
            await ctx.startInstance(name, config, topicMode ?? false);
            ctx.emitSseEvent("status", getUiStatus(ctx, startedAt));
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: `Start failed: ${(err as Error).message}` }));
          }
        })();
        return;
      }

      // Instance restart (immediate, no idle wait)
      if (req.method === "POST" && req.url?.startsWith("/restart/")) {
        const name = decodeURIComponent(req.url.slice("/restart/".length));
        ctx.logger.info({ name }, "Instance restart requested via HTTP");
        (async () => {
          try {
            await ctx.restartSingleInstance(name);
            ctx.logger.info({ name }, "Instance restarted");
            ctx.emitSseEvent("status", getUiStatus(ctx, startedAt));
            res.writeHead(200);
            res.end(JSON.stringify({ restarted: name }));
          } catch (err) {
            ctx.logger.error({ err, name }, "Instance restart failed");
            const status = (err as Error).message.includes("not found") ? 404 : 500;
            res.writeHead(status);
            res.end(JSON.stringify({ error: `Restart failed: ${(err as Error).message}` }));
          }
        })();
        return;
      }

      // ── Agent CLI endpoint ─────
      if (req.url === "/agent" && req.method === "POST") {
        handleAgentRequest(req, res, ctx as unknown as AgentEndpointContext);
        return;
      }

      // ── Web UI endpoints (delegated to web-api.ts) ─────

      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (handleWebRequest(req, res, url, ctx as unknown as WebApiContext)) return;

      res.writeHead(404);
      res.end(JSON.stringify({ error: "not found" }));
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        ctx.logger.warn({ port }, "Health port in use — attempting takeover");
        const pidPath = join(ctx.dataDir, "fleet.pid");
        try {
          if (existsSync(pidPath)) {
            const oldPid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
            if (oldPid && oldPid !== process.pid) {
              process.kill(oldPid, "SIGTERM");
              ctx.logger.info({ oldPid }, "Killed old fleet process");
            }
          }
        } catch (err) {
          ctx.logger.debug({ err }, "Old fleet process kill skipped (already gone or no permission)");
        }
        setTimeout(() => {
          if (!server) return;
          server.listen(port, "127.0.0.1", () => {
            ctx.logger.info({ port }, "Health endpoint listening (after takeover)");
          }).on("error", () => {
            ctx.logger.warn({ port }, "Health port still in use — skipping health endpoint");
          });
        }, 1500);
        return;
      }
      ctx.logger.error({ err, port }, "Health server error");
    });

    server.listen(port, "127.0.0.1", () => {
      ctx.logger.info({ port }, "Health endpoint listening");
    });

    ctx.logger.info({ url: `http://localhost:${port}/ui?token=${webToken}` }, "Web UI available");
    return { server, webToken, startedAt };
  }

export function getUiStatus(ctx: UiStatusContext, startedAt: number): unknown {
    const instances = Object.keys(ctx.fleetConfig?.instances ?? {}).map(name => {
      const statusFile = join(ctx.getInstanceDir(name), "statusline.json");
      let context_pct = 0;
      let cost = 0;
      let model = "";
      try {
        const data = JSON.parse(readFileSync(statusFile, "utf-8"));
        context_pct = data.context_window?.used_percentage ?? 0;
        cost = data.cost?.total_cost_usd ?? 0;
        model = data.model?.display_name ?? "";
      } catch (err) {
        ctx.logger.debug({ err, name }, "statusline.json read failed (getUiStatus)");
      }
      return { name, status: ctx.getInstanceStatus(name), context_pct, cost, model };
    });
    return {
      instances,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    };
  }
