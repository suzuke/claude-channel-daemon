/**
 * Agent CLI HTTP endpoint — handles POST /agent requests from thin CLI clients.
 * Replaces MCP tool calls with a simple JSON-in/JSON-out HTTP API.
 *
 * Request:  POST /agent { "instance": "dev", "op": "reply", "args": { "text": "hello" } }
 * Response: JSON result (same shape as MCP tool results)
 *
 * Authentication: every request must carry `X-Agend-Instance-Token`. The
 * daemon writes a fresh 32-byte token to <instanceDir>/agent.token (mode 0600)
 * on each spawn; agent-cli reads it and sends it in the header. The endpoint
 * verifies the header matches the on-disk token for the claimed instance,
 * preventing a local process from impersonating another instance.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { OutboundContext } from "./outbound-handlers.js";
import { outboundHandlers } from "./outbound-handlers.js";
import { routeToolCall } from "./channel/tool-router.js";

/** Op name mapping: CLI command → internal tool name */
const OP_MAP: Record<string, string> = {
  // Channel
  reply: "reply",
  react: "react",
  edit: "edit_message",
  download: "download_attachment",
  // Communication
  send: "send_to_instance",
  delegate: "delegate_task",
  report: "report_result",
  ask: "request_information",
  broadcast: "broadcast",
  // Instance management
  list: "list_instances",
  describe: "describe_instance",
  start: "start_instance",
  spawn: "create_instance",
  delete: "delete_instance",
  replace: "replace_instance",
  rename: "set_display_name",
  "set-description": "set_description",
  // Teams
  "team-create": "create_team",
  "team-delete": "delete_team",
  "team-list": "list_teams",
  "team-update": "update_team",
  // Deployments
  deploy: "deploy_template",
  teardown: "teardown_deployment",
  "deploy-list": "list_deployments",
};

/** Schedule/decision/task ops handled separately (they go through fleet-manager CRUD methods) */
type CrudHandler = (ctx: OutboundContext, instance: string, args: Record<string, unknown>) => Promise<unknown>;

export interface AgentEndpointContext extends OutboundContext {
  /** Absolute data directory (e.g. ~/.agend). Used to locate per-instance token files. */
  readonly dataDir: string;
  handleScheduleCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown>;
  handleDecisionCrudHttp(instance: string, op: string, args: Record<string, unknown>): Promise<unknown>;
  handleTaskCrudHttp(instance: string, args: Record<string, unknown>): Promise<unknown>;
  handleSetDisplayNameHttp(instance: string, name: string): Promise<unknown>;
  handleSetDescriptionHttp(instance: string, description: string): Promise<unknown>;
}

/**
 * Constant-time comparison of the provided header against the per-instance
 * token file. Returns true on match, false on any error (missing file, bad
 * instance name, length mismatch, wrong value).
 */
function verifyInstanceToken(
  ctx: AgentEndpointContext,
  instance: string,
  provided: string | undefined,
): boolean {
  if (!provided) return false;
  // instance name must be a safe filename component
  if (!/^[A-Za-z0-9._-]+$/.test(instance)) return false;
  const tokenPath = join(ctx.dataDir, "instances", instance, "agent.token");
  let expected: string;
  try {
    expected = readFileSync(tokenPath, "utf-8").trim();
  } catch {
    return false;
  }
  if (!expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function handleAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: AgentEndpointContext,
): void {
  if (req.method !== "POST") {
    res.writeHead(405);
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  req.on("data", (chunk: Buffer) => { body += chunk; });
  req.on("end", async () => {
    try {
      const { instance, op, args = {} } = JSON.parse(body) as {
        instance: string;
        op: string;
        args?: Record<string, unknown>;
      };

      if (!instance || !op) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing instance or op" }));
        return;
      }

      const headerToken = req.headers["x-agend-instance-token"];
      const providedToken = typeof headerToken === "string"
        ? headerToken
        : Array.isArray(headerToken) ? headerToken[0] : undefined;
      if (!verifyInstanceToken(ctx, instance, providedToken)) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: "Invalid or missing instance token" }));
        return;
      }

      const result = await dispatch(ctx, instance, op, args);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
}

async function dispatch(
  ctx: AgentEndpointContext,
  instance: string,
  op: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Schedule CRUD
  if (op.startsWith("schedule-")) {
    const subOp = op.replace("schedule-", "");
    return ctx.handleScheduleCrudHttp(instance, subOp, args);
  }

  // Decision CRUD
  if (op.startsWith("decision-")) {
    const subOp = op.replace("decision-", "");
    return ctx.handleDecisionCrudHttp(instance, subOp, args);
  }

  // Task board
  if (op === "task") {
    return ctx.handleTaskCrudHttp(instance, args);
  }

  // Display name / description
  if (op === "rename") {
    return ctx.handleSetDisplayNameHttp(instance, args.name as string ?? args.display_name as string ?? "");
  }
  if (op === "set-description") {
    return ctx.handleSetDescriptionHttp(instance, args.description as string ?? "");
  }

  // Map CLI op to internal tool name
  const tool = OP_MAP[op];
  if (!tool) {
    return { error: `Unknown op: ${op}` };
  }

  // Channel tools (reply, react, edit, download)
  const channelTools = new Set(["reply", "react", "edit_message", "download_attachment"]);
  if (channelTools.has(tool)) {
    return new Promise((resolve) => {
      const threadId = ctx.fleetConfig?.instances[instance]?.topic_id != null
        ? String(ctx.fleetConfig.instances[instance].topic_id)
        : undefined;
      const chatId = ctx.fleetConfig?.channel?.group_id
        ? String(ctx.fleetConfig.channel.group_id)
        : "";
      const fullArgs = { ...args, chat_id: chatId, thread_id: threadId };
      const handled = routeToolCall(ctx.adapter!, tool, fullArgs, threadId, (result, error) => {
        resolve(error ? { error } : result);
      });
      if (!handled) resolve({ error: `Unhandled channel tool: ${tool}` });
    });
  }

  // Fleet tools (outbound handlers)
  const handler = outboundHandlers.get(tool);
  if (!handler) {
    return { error: `No handler for tool: ${tool}` };
  }

  return new Promise((resolve) => {
    handler(ctx, args, (result, error) => {
      resolve(error ? { error } : result);
    }, { instanceName: instance, requestId: undefined, fleetRequestId: undefined, senderSessionName: undefined });
  });
}
