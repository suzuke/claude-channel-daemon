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
import { IpcClient } from "./ipc-bridge.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.CCD_SOCKET_PATH;
if (!SOCKET_PATH) {
  process.stderr.write(
    "ccd-channel: CCD_SOCKET_PATH environment variable is required\n",
  );
  process.exit(1);
}

const IPC_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

process.on("unhandledRejection", (err) => {
  process.stderr.write(`ccd-channel: unhandled rejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`ccd-channel: uncaught exception: ${err}\n`);
});

// ---------------------------------------------------------------------------
// IPC client with request-response
// ---------------------------------------------------------------------------

const ipc = new IpcClient(SOCKET_PATH);
let ipcConnected = false;
let requestCounter = 0;
const pendingRequests = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
>();

async function connectIpc(): Promise<void> {
  try {
    await ipc.connect();
    ipcConnected = true;
    process.stderr.write("ccd-channel: connected to daemon IPC\n");
  } catch (err) {
    process.stderr.write(
      `ccd-channel: failed to connect to daemon IPC: ${err}\n`,
    );
    ipcConnected = false;
  }
}

ipc.on("message", (msg: Record<string, unknown>) => {
  // Response to a pending request
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

  // Inbound channel message from daemon
  if (msg.type === "channel_message") {
    pushChannelMessage(msg as unknown as ChannelIpcMessage);
  }
});

// Handle IPC disconnection
const origClose = ipc.close.bind(ipc);
// We detect disconnection via the socket's close/error events. The IpcClient
// emits these on its internal socket. We listen for them after connection.
function setupDisconnectHandler(): void {
  // The IpcClient EventEmitter doesn't expose socket events directly,
  // but we can detect disconnection when send fails or via a heartbeat.
  // For robustness, wrap send to catch write errors.
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
    if (!ipcConnected) {
      reject(new Error("Not connected to daemon IPC"));
      return;
    }

    const requestId = ++requestCounter;
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`IPC request timed out after ${IPC_TIMEOUT_MS}ms`));
    }, IPC_TIMEOUT_MS);

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

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const mcp = new Server(
  { name: "ccd-channel", version: "0.1.0" },
  {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions: [
      "Messages from channels arrive as <channel source=\"ccd\" chat_id=\"...\" message_id=\"...\" user=\"...\" ts=\"...\">.",
      "Reply using the reply tool -- pass chat_id back. Use reply_to (set to a message_id) to thread.",
      "Use react to add emoji reactions, edit_message for progress updates, and download_attachment for file attachments.",
      "If the inbound meta has attachment_file_id, call download_attachment with that file_id to fetch the file, then Read the returned path.",
    ].join("\n"),
  },
);

// --- Tool definitions ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "reply",
      description:
        "Reply on the channel. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          text: { type: "string" },
          reply_to: {
            type: "string",
            description:
              "Message ID to thread under. Use message_id from the inbound <channel> block.",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Absolute file paths to attach.",
          },
          format: {
            type: "string",
            enum: ["text", "markdown"],
            description: "Rendering mode. Default: 'text'.",
          },
        },
        required: ["chat_id", "text"],
      },
    },
    {
      name: "react",
      description: "Add an emoji reaction to a channel message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          emoji: { type: "string" },
        },
        required: ["chat_id", "message_id", "emoji"],
      },
    },
    {
      name: "edit_message",
      description:
        "Edit a message the bot previously sent. Useful for interim progress updates.",
      inputSchema: {
        type: "object" as const,
        properties: {
          chat_id: { type: "string" },
          message_id: { type: "string" },
          text: { type: "string" },
          format: {
            type: "string",
            enum: ["text", "markdown"],
            description: "Rendering mode. Default: 'text'.",
          },
        },
        required: ["chat_id", "message_id", "text"],
      },
    },
    {
      name: "download_attachment",
      description:
        "Download a file attachment from a channel message. Returns the local file path ready to Read.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: {
            type: "string",
            description: "The attachment_file_id from inbound meta",
          },
        },
        required: ["file_id"],
      },
    },
  ],
}));

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
  // Connect to daemon IPC first
  await connectIpc();
  setupDisconnectHandler();

  // Announce ourselves to the daemon so it knows the MCP server is up
  if (ipcConnected) {
    ipc.send({ type: "mcp_ready" });
  }

  // Start MCP stdio transport (Claude <-> this process)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  process.stderr.write("ccd-channel: MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`ccd-channel: fatal error: ${err}\n`);
  process.exit(1);
});
