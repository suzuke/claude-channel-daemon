#!/usr/bin/env node
/**
 * POC: Headless per-call architecture for CCD
 *
 * Demonstrates how CCD could work without tmux and channel protocol:
 * - Inbound: direct function call (no tmux paste-buffer needed)
 * - Outbound: parse stdout JSON (no channel notification needed)
 * - MCP tools: loaded via --mcp-config (no --dangerously-load-development-channels)
 * - Session continuity: --resume with session ID
 *
 * Usage: node poc-headless.mjs
 *
 * NOTE: Requires active Claude Code subscription (not rate limited)
 */

import { execFile } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const POC_DIR = join(tmpdir(), "ccd-headless-poc");
mkdirSync(POC_DIR, { recursive: true });

// ── MCP Server: minimal reply tool ──────────────────────────────
// In production, this would be the full ccd-channel MCP server
// but without claude/channel capability (no push notifications)
const mcpServerCode = `
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");

const server = new Server(
  { name: "ccd-headless", version: "0.1.0" },
  { capabilities: { tools: {} } }  // NO claude/channel — pure standard MCP
);

server.setRequestHandler({ method: "tools/list" }, async () => ({
  tools: [
    {
      name: "reply",
      description: "Send a reply to the user on Telegram. Always use this to respond.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The reply text" },
        },
        required: ["text"],
      },
    },
    {
      name: "send_to_instance",
      description: "Send a message to another CCD instance",
      inputSchema: {
        type: "object",
        properties: {
          instance_name: { type: "string" },
          message: { type: "string" },
        },
        required: ["instance_name", "message"],
      },
    },
  ],
}));

server.setRequestHandler({ method: "tools/call" }, async (req) => {
  const { name, arguments: args } = req.params;
  // Write tool calls to stderr so the parent process can capture them
  process.stderr.write(JSON.stringify({ type: "tool_call", tool: name, args }) + "\\n");
  return { content: [{ type: "text", text: "ok" }] };
});

const transport = new StdioServerTransport();
server.connect(transport);
`;

const mcpServerPath = join(POC_DIR, "mcp-server.cjs");
writeFileSync(mcpServerPath, mcpServerCode);

// ── MCP Config ──────────────────────────────────────────────────
const mcpConfig = {
  mcpServers: {
    "ccd-headless": {
      command: "node",
      args: [mcpServerPath],
    },
  },
};
const mcpConfigPath = join(POC_DIR, "mcp-config.json");
writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig));

// ── Headless Backend ────────────────────────────────────────────

class HeadlessBackend {
  constructor(workingDirectory) {
    this.workingDirectory = workingDirectory;
    this.sessionId = null;
  }

  /**
   * Send a message to the CLI agent and get the response.
   * Returns { result, toolCalls, sessionId, durationMs }
   */
  async send(message, systemPrompt) {
    const args = [
      "-p", message,
      "--output-format", "json",
      "--mcp-config", mcpConfigPath,
      "--allowedTools", "mcp__ccd-headless__reply,mcp__ccd-headless__send_to_instance",
      "--dangerously-skip-permissions",
    ];

    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
    }

    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const toolCalls = [];
      let stdout = "";
      let stderr = "";

      const proc = execFile("claude", args, {
        cwd: this.workingDirectory,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
      }, (err, out, errOut) => {
        stdout = out;
        stderr = errOut;

        // Parse tool calls from MCP server stderr
        for (const line of stderr.split("\n")) {
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "tool_call") {
              toolCalls.push(parsed);
            }
          } catch { /* not JSON */ }
        }

        // Parse result from stdout
        try {
          const result = JSON.parse(stdout);
          this.sessionId = result.session_id;

          resolve({
            result: result.result,
            isError: result.is_error,
            sessionId: result.session_id,
            numTurns: result.num_turns,
            durationMs: Date.now() - startTime,
            apiDurationMs: result.duration_api_ms,
            cost: result.total_cost_usd,
            toolCalls,
          });
        } catch (e) {
          reject(new Error(`Failed to parse output: ${stdout.slice(0, 200)}`));
        }
      });
    });
  }
}

// ── Simulate CCD flow ───────────────────────────────────────────

async function main() {
  console.log("=== CCD Headless POC ===\n");

  const backend = new HeadlessBackend(process.cwd());

  const systemPrompt = `You are a CCD fleet instance. When users send you messages, always reply using the reply tool. Never respond directly in text — use the reply tool for all responses.`;

  // Simulate: Telegram user sends a message
  console.log("📱 Simulating Telegram inbound: 'What files are in this directory?'");
  console.log("   Spawning claude -p ...\n");

  const t1 = Date.now();
  const response = await backend.send(
    "What files are in this directory? Use the reply tool to respond.",
    systemPrompt,
  );
  const totalMs = Date.now() - t1;

  console.log("📊 Results:");
  console.log(`   Session ID: ${response.sessionId}`);
  console.log(`   Total time: ${totalMs}ms (API: ${response.apiDurationMs}ms)`);
  console.log(`   Turns: ${response.numTurns}`);
  console.log(`   Cost: $${response.cost}`);
  console.log(`   Is error: ${response.isError}`);
  console.log(`   Tool calls: ${response.toolCalls.length}`);

  for (const tc of response.toolCalls) {
    console.log(`     → ${tc.tool}(${JSON.stringify(tc.args).slice(0, 100)})`);
  }

  console.log(`   Result text: ${response.result?.slice(0, 200)}`);

  if (response.isError) {
    console.log("\n⚠️  Got error (likely rate limited). Architecture is valid but can't test full flow.");
    console.log("   When not rate limited, the flow would be:");
    console.log("   1. claude -p receives message as prompt argument");
    console.log("   2. Claude processes it, calls reply MCP tool");
    console.log("   3. MCP server logs tool call to stderr");
    console.log("   4. CCD captures tool call, sends to Telegram");
    console.log("   5. Session ID saved for --resume on next message");
    return;
  }

  // Simulate: second message (resume)
  console.log("\n📱 Simulating second message: 'Tell me more about package.json'");
  const response2 = await backend.send("Tell me more about package.json. Use the reply tool.");
  console.log(`   Total time: ${Date.now() - t1}ms`);
  console.log(`   Session ID: ${response2.sessionId} (same: ${response2.sessionId === response.sessionId})`);
  console.log(`   Tool calls: ${response2.toolCalls.length}`);
  for (const tc of response2.toolCalls) {
    console.log(`     → ${tc.tool}(${JSON.stringify(tc.args).slice(0, 100)})`);
  }
}

main().catch(console.error);
