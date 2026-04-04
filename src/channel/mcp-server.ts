#!/usr/bin/env node
/**
 * MCP Tool Server for agend.
 *
 * Runs as a SEPARATE process (CLI's child via --mcp-config).
 * Communicates with the daemon through a Unix socket IPC connection.
 * Provides standard MCP tools (reply, send_to_instance, etc.) — no
 * CLI-specific channel protocol. Works with any MCP-compatible CLI.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { IpcClient } from "./ipc-bridge.js";
import { TOOLS } from "./mcp-tools.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.AGEND_SOCKET_PATH ?? "";
const IPC_TIMEOUT_MS = 30_000;
const SLOW_IPC_TIMEOUT_MS = 60_000;

const SLOW_TOOLS = new Set(["start_instance", "create_instance", "delete_instance"]);

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

// When the parent Claude process dies, stdin closes. Exit immediately to avoid
// becoming an orphaned process that spins CPU forever on reconnect loops.
process.stdin.on("end", () => {
  process.stderr.write("agend: stdin closed (parent died) — exiting\n");
  process.exit(0);
});
process.stdin.resume(); // ensure 'end' fires even if nothing reads stdin

process.on("unhandledRejection", (err) => {
  process.stderr.write(`agend: unhandled rejection: ${err}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`agend: uncaught exception: ${err}\n`);
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
    }
  });

  client.on("disconnect", () => {
    ipcConnected = false;
    process.stderr.write("agend: IPC disconnected — will reconnect\n");
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
    // AGEND_INSTANCE_NAME: set by daemon via tmux env (internal sessions)
    // AGEND_SESSION_NAME: set in .mcp.json env (external sessions, optional custom name)
    // Fallback: unique name from working directory + PID (avoids collision when
    // multiple Claude Code sessions work on the same project)
    const sessionName = process.env.AGEND_INSTANCE_NAME
      ?? process.env.AGEND_SESSION_NAME
      ?? `external-${basename(process.cwd())}-${process.pid}`;
    client.send({ type: "mcp_ready", sessionName });
    process.stderr.write("agend: connected to daemon IPC\n");
  } catch (err) {
    process.stderr.write(`agend: failed to connect to daemon IPC: ${err}\n`);
    ipcConnected = false;
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (reconnecting) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    process.stderr.write(`agend: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) exceeded — exiting\n`);
    process.exit(1);
  }
  reconnecting = true;
  const delay = 3000;
  process.stderr.write(`agend: reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...\n`);
  setTimeout(() => {
    reconnecting = false;
    connectIpc();
  }, delay);
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

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dynamic MCP instructions — carries fleet context + user custom prompt
// so we never need to touch the CLI's own system prompt.
// ---------------------------------------------------------------------------

function buildMcpInstructions(): string {
  const name = process.env.AGEND_INSTANCE_NAME ?? "unknown";
  const workDir = process.env.AGEND_WORKING_DIR ?? process.cwd();
  const displayName = process.env.AGEND_DISPLAY_NAME;
  const description = process.env.AGEND_DESCRIPTION;
  const customPrompt = process.env.AGEND_CUSTOM_PROMPT;
  const workflowEnv = process.env.AGEND_WORKFLOW;

  const sections: string[] = [];

  // ── Identity ──
  sections.push(`# AgEnD Fleet Context\nYou are **${name}**, an instance in an AgEnD fleet.\nYour working directory is \`${workDir}\`.`);
  if (displayName) {
    sections.push(`Your display name is "${displayName}". Use this when introducing yourself.`);
  } else {
    sections.push("You don't have a display name yet. Use set_display_name to choose one that reflects your personality.");
  }
  if (description) {
    sections.push(`## Role\n${description}`);
  }

  // ── Message format & tool usage ──
  sections.push([
    "## Message Format",
    "- `[user:name]` — from a Telegram/Discord user → reply with the `reply` tool.",
    "- `[from:instance-name]` — from another fleet instance → reply with `send_to_instance`, NOT the reply tool.",
    "",
    "**Always use the `reply` tool for ALL responses to users.** Do not respond directly in the terminal.",
    "",
    "## Tool Usage",
    "- reply: respond to users. react: emoji reactions. edit_message: update a sent message. download_attachment: fetch files.",
    "- If the inbound message has image_path, Read that file — it is a photo.",
    "- If the inbound message has attachment_file_id, call download_attachment then Read the returned path.",
    "- If the inbound message has reply_to_text, the user is quoting a previous message.",
    "- Use list_instances to discover fleet members. Use describe_instance for details.",
    "- High-level collaboration: request_information (ask), delegate_task (assign), report_result (return results with correlation_id).",
    "",
    "## Collaboration Rules",
    "1. Use fleet tools for cross-instance communication. Never assume direct file access to another instance's repo.",
    "2. Cross-instance messages appear as `[from:instance-name]`. Reply via send_to_instance or report_result, NOT reply.",
    "3. Use list_instances to discover available instances before sending messages.",
    "4. You only have direct access to files under your own working directory.",
  ].join("\n"));

  // ── Workflow template ──
  if (workflowEnv !== "false") {
    let workflowContent: string | null = null;
    if (workflowEnv) {
      // Custom workflow passed from daemon (inline or file: already resolved)
      workflowContent = workflowEnv;
    } else {
      // Default: load built-in template
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        workflowContent = readFileSync(join(here, "../workflow-templates/default.md"), "utf-8");
      } catch { /* template not found — skip */ }
    }
    if (workflowContent) {
      sections.push(`## Development Workflow\n\n${workflowContent}`);
    }
  }

  // ── Custom user prompt ──
  if (customPrompt) {
    sections.push(customPrompt);
  }

  return sections.join("\n\n");
}

const mcp = new Server(
  { name: "agend", version: "0.3.0" },
  {
    capabilities: {
      tools: {},
    },
    instructions: buildMcpInstructions(),
  },
);

// --- Tool definitions (see mcp-tools.ts) ---

import { TOOL_SETS } from "./mcp-tools.js";
export { TOOLS } from "./mcp-tools.js";

const toolSet = process.env.AGEND_TOOL_SET;
let activeTools: typeof TOOLS;
if (!toolSet || toolSet === "full") {
  activeTools = TOOLS;
} else if (TOOL_SETS[toolSet]) {
  activeTools = TOOLS.filter(t => TOOL_SETS[toolSet].includes(t.name));
} else {
  process.stderr.write(`agend: ERROR — unknown AGEND_TOOL_SET "${toolSet}", valid: ${Object.keys(TOOL_SETS).join(", ")}. Using "full".\n`);
  activeTools = TOOLS;
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: activeTools }));

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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!SOCKET_PATH) {
    process.stderr.write("agend: AGEND_SOCKET_PATH environment variable is required\n");
    process.exit(1);
  }
  // Connect to daemon IPC first (will auto-reconnect on disconnect)
  await connectIpc();

  // Start MCP stdio transport (Claude <-> this process)
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  process.stderr.write("agend: MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`agend: fatal error: ${err}\n`);
  process.exit(1);
});
