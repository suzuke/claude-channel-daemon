#!/usr/bin/env node
/**
 * MCP Channel Server for claude-channel-daemon.
 *
 * Runs as a SEPARATE process (Claude Code's child via the ccd-channel plugin).
 * Communicates with the daemon ONLY through a Unix socket IPC connection.
 *
 * Key mechanisms discovered from the official Telegram plugin:
 * - Uses `Server` from `@modelcontextprotocol/sdk/server/index.js`
 * - Uses `StdioServerTransport` for Claude <-> MCP communication
 * - Declares `capabilities: { tools: {}, experimental: { 'claude/channel': {} } }`
 * - Pushes inbound messages via `mcp.notification()` with:
 *     method: 'notifications/claude/channel'
 *     params: { content: string, meta: Record<string, string> }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { basename } from "node:path";
import { IpcClient } from "./ipc-bridge.js";
import { TOOLS } from "./mcp-tools.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.CCD_SOCKET_PATH ?? "";
const IPC_TIMEOUT_MS = 30_000;
const SLOW_IPC_TIMEOUT_MS = 60_000;
const PERMISSION_TIMEOUT_MS = 120_000;

const SLOW_TOOLS = new Set(["start_instance", "create_instance", "delete_instance"]);

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

// When the parent Claude process dies, stdin closes. Exit immediately to avoid
// becoming an orphaned process that spins CPU forever on reconnect loops.
process.stdin.on("end", () => {
  process.stderr.write("ccd-channel: stdin closed (parent died) — exiting\n");
  process.exit(0);
});
process.stdin.resume(); // ensure 'end' fires even if nothing reads stdin

process.on("unhandledRejection", (err) => {
  process.stderr.write(`ccd-channel: unhandled rejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`ccd-channel: uncaught exception: ${err}\n`);
});

// ---------------------------------------------------------------------------
// IPC client with request-response
// ---------------------------------------------------------------------------

let ipc: IpcClient | null = null;
let ipcConnected = false;
let requestCounter = 0;
let reconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20; // ~60s of retries
const pendingRequests = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

function setupIpcListeners(client: IpcClient): void {
  client.on("message", (msg: Record<string, unknown>) => {
    if (typeof msg.requestId === "number" && pendingRequests.has(msg.requestId)) {
      const pending = pendingRequests.get(msg.requestId)!;
      pendingRequests.delete(msg.requestId);
      clearTimeout(pending.timer);
      if (msg.error) {
        pending.reject(new Error(String(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.type === "channel_message") {
      pushChannelMessage(msg as unknown as ChannelIpcMessage);
    }
  });

  client.on("disconnect", () => {
    ipcConnected = false;
    process.stderr.write("ccd-channel: IPC disconnected — will reconnect\n");
    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("IPC disconnected"));
      pendingRequests.delete(id);
    }
    scheduleReconnect();
  });
}

async function connectIpc(): Promise<void> {
  try {
    const client = new IpcClient(SOCKET_PATH!);
    await client.connect();
    ipc = client;
    ipcConnected = true;
    reconnecting = false;
    reconnectAttempts = 0;
    setupIpcListeners(client);
    // CCD_INSTANCE_NAME: set by daemon via tmux env (internal sessions)
    // CCD_SESSION_NAME: set in .mcp.json env (external sessions, optional custom name)
    // Fallback: unique name from working directory + PID (avoids collision when
    // multiple Claude Code sessions work on the same project)
    const sessionName = process.env.CCD_INSTANCE_NAME
      ?? process.env.CCD_SESSION_NAME
      ?? `external-${basename(process.cwd())}-${process.pid}`;
    client.send({ type: "mcp_ready", sessionName });
    process.stderr.write("ccd-channel: connected to daemon IPC\n");
  } catch (err) {
    process.stderr.write(`ccd-channel: failed to connect to daemon IPC: ${err}\n`);
    ipcConnected = false;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnecting) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    process.stderr.write(`ccd-channel: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded — exiting\n`);
    process.exit(1);
  }
  reconnecting = true;
  const delay = 3000;
  process.stderr.write(`ccd-channel: reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...\n`);
  setTimeout(() => {
    reconnecting = false;
    connectIpc();
  }, delay);
}

interface ChannelIpcMessage {
  type: string;
  content: string;
  meta: Record<string, string>;
}

function ipcRequest(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ipcConnected || !ipc) {
      reject(new Error("Not connected to daemon IPC"));
      return;
    }

    const timeoutMs = SLOW_TOOLS.has(tool) ? SLOW_IPC_TIMEOUT_MS : IPC_TIMEOUT_MS;
    const requestId = ++requestCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`IPC request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    pendingRequests.set(requestId, { resolve, reject, timer });

    try {
      ipc.send({ type: "tool_call", tool, args, requestId });
    } catch (err) {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      ipcConnected = false;
      reject(new Error(`IPC send failed: ${err}`));
    }
  });
}

function ipcPermissionRequest(
  request_id: string,
  tool_name: string,
  description: string,
  input_preview?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ipcConnected || !ipc) {
      reject(new Error("Not connected to daemon IPC"));
      return;
    }
    const requestId = ++requestCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Permission request timed out after ${PERMISSION_TIMEOUT_MS}ms`));
    }, PERMISSION_TIMEOUT_MS);
    pendingRequests.set(requestId, { resolve, reject, timer });
    try {
      ipc.send({
        type: "permission_request",
        requestId,
        request_id,
        tool_name,
        description,
        input_preview,
      });
    } catch (err) {
      pendingRequests.delete(requestId);
      clearTimeout(timer);
      ipcConnected = false;
      reject(new Error(`IPC send failed: ${err}`));
    }
  });
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "ccd-channel", version: "0.2.0" },
  {
    capabilities: {
      tools: {},
      experimental: {
        "claude/channel": {},
        "claude/channel/permission": {},
      },
    },
    instructions: [
      "Messages from channels arrive as <channel source=\"ccd\" chat_id=\"...\" message_id=\"...\" user=\"...\" ts=\"...\">.",
      "Reply using the reply tool -- pass chat_id back. Use reply_to (set to a message_id) to thread. IMPORTANT: chat_id and thread_id in reply must come from the inbound <channel> message only — never use a topic_id from list_instances as thread_id.",
      "Use react to add emoji reactions, edit_message for progress updates, and download_attachment for file attachments.",
      "If the inbound meta has image_path, Read that file — it is a photo the sender attached.",
      "If the inbound meta has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path.",
      "If the inbound meta has reply_to_text, the user is quoting/replying to a previous message — reply_to_text contains the original message text.",
      "Use send_to_instance to communicate with other Claude instances. Messages are passive — the recipient sees them but is not forced to respond. Use list_instances to discover available instances.",
      "Cross-instance messages (from_instance in meta) must be replied to via send_to_instance, NOT the reply tool. The reply tool is for Telegram only.",
      "Cross-instance meta fields: from_instance (sender name), request_kind (query|task|report|update), requires_reply (boolean), correlation_id (for request-response pairing), task_summary (brief description).",
      "High-level collaboration tools: request_information (ask a question), delegate_task (assign work), report_result (return results with correlation_id). These wrap send_to_instance with appropriate metadata.",
      "Use describe_instance to get detailed info about a specific instance before interacting with it.",
    ].join("\n"),
  },
);

// --- Tool definitions (see mcp-tools.ts) ---

export { TOOLS } from "./mcp-tools.js";

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// --- Tool call handler ---

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;

  try {
    const result = await ipcRequest(req.params.name, args);
    const text =
      typeof result === "string" ? result : JSON.stringify(result ?? "ok");
    return { content: [{ type: "text", text }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

const PermissionRequestNotificationSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string().optional(),
  }),
});

mcp.setNotificationHandler(
  PermissionRequestNotificationSchema,
  async (notification) => {
    const params = notification.params;
    try {
      const result = await ipcPermissionRequest(
        params.request_id,
        params.tool_name,
        params.description,
        params.input_preview,
      ) as { request_id: string; behavior: "allow" | "deny" };
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: result.request_id,
          behavior: result.behavior,
        },
      });
    } catch (err) {
      process.stderr.write(`ccd-channel: permission relay error: ${err}\n`);
      await mcp.notification({
        method: "notifications/claude/channel/permission",
        params: {
          request_id: params.request_id,
          behavior: "deny",
        },
      });
    }
  },
);

// ---------------------------------------------------------------------------
// Inbound: push channel messages to Claude
// ---------------------------------------------------------------------------

function pushChannelMessage(msg: ChannelIpcMessage): void {
  mcp
    .notification({
      method: "notifications/claude/channel",
      params: {
        content: msg.content,
        meta: msg.meta ?? {},
      },
    })
    .catch((err) => {
      process.stderr.write(
        `ccd-channel: failed to push channel message: ${err}\n`,
      );
    });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!SOCKET_PATH) {
    process.stderr.write("ccd-channel: CCD_SOCKET_PATH environment variable is required\n");
    process.exit(1);
  }
  // Connect to daemon IPC first (will auto-reconnect on disconnect)
  await connectIpc();

  // Start MCP stdio transport (Claude <-> this process)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  process.stderr.write("ccd-channel: MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`ccd-channel: fatal error: ${err}\n`);
  process.exit(1);
});
