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
      "Reply using the reply tool -- pass chat_id back. Use reply_to (set to a message_id) to thread.",
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
    {
      name: "create_schedule",
      description: "Create a cron-based schedule. When triggered, sends a message to the target instance.",
      inputSchema: {
        type: "object" as const,
        properties: {
          cron: { type: "string", description: "Cron expression, e.g. '0 7 * * *' (every day at 7 AM)" },
          message: { type: "string", description: "Message to inject when triggered" },
          target: { type: "string", description: "Target instance name. Defaults to this instance if omitted." },
          label: { type: "string", description: "Human-readable name for this schedule" },
          timezone: { type: "string", description: "IANA timezone, e.g. 'Asia/Taipei'. Defaults to Asia/Taipei." },
        },
        required: ["cron", "message"],
      },
    },
    {
      name: "list_schedules",
      description: "List all schedules. Optionally filter by target instance.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target: { type: "string", description: "Filter by target instance name" },
        },
      },
    },
    {
      name: "update_schedule",
      description: "Update an existing schedule. Only include fields you want to change.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Schedule ID" },
          cron: { type: "string", description: "New cron expression" },
          message: { type: "string", description: "New message" },
          target: { type: "string", description: "New target instance" },
          label: { type: "string", description: "New label" },
          timezone: { type: "string", description: "New timezone" },
          enabled: { type: "boolean", description: "Enable/disable the schedule" },
        },
        required: ["id"],
      },
    },
    {
      name: "delete_schedule",
      description: "Delete a schedule by ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "Schedule ID to delete" },
        },
        required: ["id"],
      },
    },
    {
      name: "send_to_instance",
      description: "Send a message to another Claude instance. The message appears in their channel as a passive notification — they decide whether to respond. Use this to share information, request reviews, or coordinate work across instances.",
      inputSchema: {
        type: "object" as const,
        properties: {
          instance_name: {
            type: "string",
            description: "Name of the target instance (e.g., 'ccplugin', 'blog-t1385'). Use list_instances to see available instances.",
          },
          message: {
            type: "string",
            description: "The message to send to the target instance.",
          },
          request_kind: {
            type: "string",
            enum: ["query", "task", "report", "update"],
            description: "Categorizes the message intent. 'query' = asking a question, 'task' = delegating work, 'report' = returning results, 'update' = status notification.",
          },
          requires_reply: {
            type: "boolean",
            description: "Whether you expect the recipient to respond. Default: false.",
          },
          correlation_id: {
            type: "string",
            description: "Echo this from a previous message to link request-response pairs.",
          },
          task_summary: {
            type: "string",
            description: "Brief summary of the task or request (shown in logs and Telegram visibility posts).",
          },
        },
        required: ["instance_name", "message"],
      },
    },
    {
      name: "request_information",
      description: "Ask another instance a question and expect a reply. Wrapper around send_to_instance with request_kind=query and requires_reply=true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_instance: {
            type: "string",
            description: "Name of the instance to ask.",
          },
          question: {
            type: "string",
            description: "The question to ask.",
          },
          context: {
            type: "string",
            description: "Optional context to help the recipient answer.",
          },
        },
        required: ["target_instance", "question"],
      },
    },
    {
      name: "delegate_task",
      description: "Delegate a task to another instance and expect a result report back. Wrapper around send_to_instance with request_kind=task and requires_reply=true.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_instance: {
            type: "string",
            description: "Name of the instance to delegate to.",
          },
          task: {
            type: "string",
            description: "Description of the task to perform.",
          },
          success_criteria: {
            type: "string",
            description: "How the recipient should judge if the task is complete.",
          },
          context: {
            type: "string",
            description: "Optional background context for the task.",
          },
        },
        required: ["target_instance", "task"],
      },
    },
    {
      name: "report_result",
      description: "Report results back to an instance that delegated a task or asked a question. Wrapper around send_to_instance with request_kind=report.",
      inputSchema: {
        type: "object" as const,
        properties: {
          target_instance: {
            type: "string",
            description: "Name of the instance to report to.",
          },
          correlation_id: {
            type: "string",
            description: "The correlation_id from the original request.",
          },
          summary: {
            type: "string",
            description: "Summary of the result.",
          },
          artifacts: {
            type: "string",
            description: "Optional details: file paths, commit hashes, URLs, etc.",
          },
        },
        required: ["target_instance", "summary"],
      },
    },
    {
      name: "describe_instance",
      description: "Get detailed information about a specific instance: description, working directory, status, tags, and recent activity.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "Instance name to describe.",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "list_instances",
      description: "List all currently running instances that you can send messages to.",
      inputSchema: {
        type: "object" as const,
        properties: {},
      },
    },
    {
      name: "start_instance",
      description:
        "Start a stopped CCD instance. Use list_instances() first to check available instances and their status. " +
        "Only needed when the target instance status is 'stopped'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "The instance name to start (from list_instances)",
          },
        },
        required: ["name"],
      },
    },
    {
      name: "create_instance",
      description:
        "Create a new CCD instance bound to a project directory, with a new Telegram topic. " +
        "Use this when the user wants to add a new project to the fleet. " +
        "The directory must exist. Returns the instance name and topic ID.",
      inputSchema: {
        type: "object" as const,
        properties: {
          directory: {
            type: "string",
            description: "Absolute path or ~-prefixed path to the project directory",
          },
          topic_name: {
            type: "string",
            description: "Name for the Telegram topic. Defaults to directory basename.",
          },
          description: {
            type: "string",
            description: "Human-readable description of what this instance does (e.g., 'Daily secretary for scheduling and reminders').",
          },
          model: {
            type: "string",
            description: "Claude model to use for this instance. Omit to use the default (usually opus).",
            enum: ["sonnet", "opus", "haiku"],
          },
          branch: {
            type: "string",
            description: "Git branch name. When specified, creates a git worktree from the directory's repo and uses it as the working directory. If the branch doesn't exist, it will be created.",
          },
        },
        required: ["directory"],
      },
    },
    {
      name: "delete_instance",
      description:
        "Delete a CCD instance: stop daemon, remove from fleet config, clean up worktree if applicable, and optionally delete the Telegram topic. " +
        "Use this when an instance is no longer needed (e.g., feature branch work is done).",
      inputSchema: {
        type: "object" as const,
        properties: {
          name: {
            type: "string",
            description: "The instance name to delete (from list_instances)",
          },
          delete_topic: {
            type: "boolean",
            description: "Whether to also delete the Telegram topic. Defaults to false.",
          },
        },
        required: ["name"],
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
