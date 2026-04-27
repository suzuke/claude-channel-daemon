import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CliBackend, CliBackendConfig, ErrorPattern } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Mock backend for E2E testing.
 *
 * Instead of spawning a real CLI (claude, gemini, etc.), it launches a small
 * Node.js script (`mock-claude.mjs`) that:
 * - Starts the real agend MCP server (connects to daemon IPC)
 * - Writes periodic statusline.json updates
 * - Accepts stdin messages and outputs canned responses
 *
 * This lets E2E tests exercise the full agend orchestration (daemon, IPC,
 * routing, tmux) without needing a real AI API or CLI binary.
 */
export class MockBackend implements CliBackend {
  readonly binaryName = "node";
  readonly nativeInstructionsMechanism = "none" as const;

  constructor(private instanceDir: string) {}

  buildCommand(config: CliBackendConfig): string {
    // Try dist path first, then src-relative path for dev mode
    const distScript = join(__dirname, "..", "e2e", "mock-servers", "mock-claude.mjs");
    const srcScript = join(__dirname, "..", "..", "e2e", "mock-servers", "mock-claude.mjs");
    const script = existsSync(distScript) ? distScript : srcScript;

    const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
    const envPrefix = [
      `AGEND_SOCKET_PATH=${q(join(this.instanceDir, "channel.sock"))}`,
      `AGEND_INSTANCE_NAME=${q(config.instanceName)}`,
      `MOCK_INSTANCE_DIR=${q(this.instanceDir)}`,
    ];

    if (process.env.MOCK_RESPONSE) envPrefix.push(`MOCK_RESPONSE=${q(process.env.MOCK_RESPONSE)}`);
    if (process.env.MOCK_DELAY) envPrefix.push(`MOCK_DELAY=${q(process.env.MOCK_DELAY)}`);

    return `${envPrefix.join(" ")} node ${q(script)}`;
  }

  writeConfig(config: CliBackendConfig): void {
    const mcpConfigPath = join(this.instanceDir, "mcp-config.json");
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: config.mcpServers }, null, 2));

    // Write initial statusline.json matching real Claude Code format
    const statusline = {
      session_id: `mock-${config.instanceName}-${Date.now()}`,
      model: "mock-model",
      cost_usd: 0,
      total_tokens: 0,
      context_window: {
        used_percentage: 0,
        context_window_size: 200000,
      },
    };
    writeFileSync(join(this.instanceDir, "statusline.json"), JSON.stringify(statusline));
  }

  getContextUsage(): number | null {
    try {
      const data = JSON.parse(readFileSync(join(this.instanceDir, "statusline.json"), "utf-8"));
      return data.context_window?.used_percentage ?? null;
    } catch {
      return null;
    }
  }

  getSessionId(): string | null {
    try {
      return readFileSync(join(this.instanceDir, "session-id"), "utf-8").trim() || null;
    } catch {
      return null;
    }
  }

  getQuitCommand(): string { return "/quit"; }

  getReadyPattern(): RegExp {
    return /MOCK_READY|mock-claude ready/;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /MOCK_RATE_LIMIT/i, type: "rate_limit", action: "failover", message: "Mock rate limit reached" },
      { pattern: /MOCK_AUTH_ERROR/i, type: "auth_error", action: "notify", message: "Mock auth error" },
    ];
  }
}
