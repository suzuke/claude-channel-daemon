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
import { basename, dirname, join } from "node:path";
import { writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { IpcClient } from "./ipc-bridge.js";
import { TOOLS } from "./mcp-tools.js";
import { buildFleetInstructions } from "../instructions.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const SOCKET_PATH = process.env.AGEND_SOCKET_PATH ?? "";
const IPC_TIMEOUT_MS = 30_000;
const SLOW_IPC_TIMEOUT_MS = 60_000;

const SLOW_TOOLS = new Set(["start_instance", "create_instance", "delete_instance", "replace_instance"]);

// ---------------------------------------------------------------------------
// Safety nets
// ---------------------------------------------------------------------------

// Parent death detection moved to main() via mcp.onclose — see below.
// DO NOT call process.stdin.resume() here. It switches stdin to flowing mode
// before StdioServerTransport starts reading, causing data loss (the CLI's
// initialize request gets discarded, breaking the MCP handshake).

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
    // Graceful shutdown: daemon tells us it's shutting down — skip reconnect
    if (msg.type === "shutdown") {
      process.stderr.write("agend: daemon shutting down — exiting gracefully\n");
      process.exit(0);
    }

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
      reject(new Error("Not connected to daemon IPC (retrying connection in background)"));
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
// MCP instructions — thin wrapper around shared buildFleetInstructions().
// Phase 1 (dual track): MCP instructions kept as fallback for backends that
// read the MCP instructions field. Content delegates to the shared module
// to avoid drift between MCP and additive system prompt paths.
// ---------------------------------------------------------------------------

function buildMcpInstructions(): string {
  const workflowEnv = process.env.AGEND_WORKFLOW;
  let workflow: string | false | undefined;
  if (workflowEnv === "false") workflow = false;
  else if (workflowEnv) workflow = workflowEnv;

  let decisions: { title: string; content: string }[] | undefined;
  if (process.env.AGEND_DECISIONS) {
    try { decisions = JSON.parse(process.env.AGEND_DECISIONS); } catch { /* skip */ }
  }

  return buildFleetInstructions({
    instanceName: process.env.AGEND_INSTANCE_NAME ?? "unknown",
    workingDirectory: process.env.AGEND_WORKING_DIR ?? process.cwd(),
    displayName: process.env.AGEND_DISPLAY_NAME,
    description: process.env.AGEND_DESCRIPTION,
    customPrompt: process.env.AGEND_CUSTOM_PROMPT,
    workflow,
    decisions,
  });
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

  // Start MCP stdio transport FIRST — must be ready before the CLI sends
  // the initialize request. IPC connection can happen in parallel.
  const transport = new StdioServerTransport();
  await mcp.connect(transport);

  // Detect parent death: StdioServerTransport only listens for 'data'/'error'
  // on stdin — it never detects EOF. mcp.onclose only fires on explicit
  // transport.close(), NOT on stdin EOF. So we need a direct stdin listener
  // as the primary parent-death detection mechanism.
  mcp.onclose = () => {
    process.stderr.write("agend: MCP transport closed — exiting\n");
    process.exit(0);
  };
  process.stdin.on("end", () => {
    process.stderr.write("agend: stdin EOF (parent exited) — exiting\n");
    process.exit(0);
  });
  process.stdin.on("close", () => {
    process.stderr.write("agend: stdin closed (parent exited) — exiting\n");
    process.exit(0);
  });
  process.stdin.on("error", () => {
    process.stderr.write("agend: stdin error (parent exited) — exiting\n");
    process.exit(0);
  });

  // Write PID file so daemon can kill orphan MCP servers on crash respawn.
  // Derived from AGEND_SOCKET_PATH (e.g. ~/.agend/instances/foo/channel.sock).
  const pidFile = join(dirname(SOCKET_PATH), "channel.mcp.pid");
  writeFileSync(pidFile, String(process.pid));
  process.on("exit", () => {
    try {
      if (readFileSync(pidFile, "utf-8").trim() === String(process.pid)) unlinkSync(pidFile);
    } catch { /* already cleaned up */ }
  });

  // Connect to daemon IPC (will auto-reconnect on disconnect)
  await connectIpc();

  process.stderr.write("agend: MCP server running\n");
}

main().catch((err) => {
  process.stderr.write(`agend: fatal error: ${err}\n`);
  process.exit(1);
});
