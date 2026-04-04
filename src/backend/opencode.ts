import { join, dirname } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, resolveBinary } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class OpenCodeBackend implements CliBackend {
  readonly binaryName = "opencode";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("opencode");
  }

  buildCommand(config: CliBackendConfig): string {
    // Use per-instance config via OPENCODE_CONFIG env (set in writeConfig)
    let cmd = this.binaryPath;

    // Resume last session if session-id exists
    const sessionIdFile = join(this.instanceDir, "session-id");
    if (existsSync(sessionIdFile)) {
      const sid = readFileSync(sessionIdFile, "utf-8").trim();
      if (sid) cmd += ` --session ${sid}`;
    } else {
      // No specific session — continue last (OpenCode auto-selects)
      cmd += " --continue";
    }

    if (config.model) {
      cmd += ` --model ${config.model}`;
    }

    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // OpenCode reads opencode.json from the working directory.
    // Use instance-specific MCP server key name to avoid conflicts when
    // multiple instances share the same working directory.
    const configPath = join(config.workingDirectory, "opencode.json");
    let oc: Record<string, unknown> = {};
    try {
      oc = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch { /* new file */ }

    // MCP servers — use instance name as key to avoid multi-instance conflicts
    const mcp = (oc.mcp ?? {}) as Record<string, unknown>;
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const instanceKey = `${name}-${config.instanceName}`;
      mcp[instanceKey] = {
        type: "local",
        command: [entry.command, ...entry.args],
        environment: { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName },
      };
    }
    // Clean up old non-namespaced key if present
    delete mcp["agend"];
    oc.mcp = mcp;
    delete oc.mcpServers;

    // Write fleet instructions file for OpenCode to pick up
    // (OpenCode doesn't inject MCP instructions into its system prompt)
    const instructionsPath = join(this.instanceDir, "fleet-instructions.md");
    writeFileSync(instructionsPath, this.buildInstructions(config));
    const instructions = (oc.instructions ?? []) as string[];
    if (!instructions.includes(instructionsPath)) {
      instructions.push(instructionsPath);
    }
    oc.instructions = instructions;

    writeFileSync(configPath, JSON.stringify(oc, null, 2));
  }

  private buildInstructions(config: CliBackendConfig): string {
    const name = config.instanceName;
    const workDir = config.workingDirectory;
    const env = config.mcpServers["agend"]?.env ?? {};
    const displayName = env.AGEND_DISPLAY_NAME;
    const description = env.AGEND_DESCRIPTION;

    const sections: string[] = [];
    sections.push(`# AgEnD Fleet Context\nYou are **${name}**, an instance in an AgEnD fleet.\nYour working directory is \`${workDir}\`.`);
    if (displayName) {
      sections.push(`Your display name is "${displayName}". Use this when introducing yourself.`);
    }
    if (description) {
      sections.push(`## Role\n${description}`);
    }
    sections.push([
      "## Message Format",
      "- `[user:name]` — from a Telegram/Discord user → reply with the `reply` tool.",
      "- `[from:instance-name]` — from another fleet instance → reply with `send_to_instance`, NOT the reply tool.",
      "",
      "**Always use the `reply` tool for ALL responses to users.** Do not respond directly in the terminal.",
      "",
      "## Collaboration Rules",
      "1. Use fleet tools for cross-instance communication. Never assume direct file access to another instance's repo.",
      "2. Cross-instance messages appear as `[from:instance-name]`. Reply via send_to_instance or report_result, NOT reply.",
      "3. Use list_instances to discover available instances before sending messages.",
      "4. You only have direct access to files under your own working directory.",
    ].join("\n"));

    // Load workflow template
    const workflowEnv = env.AGEND_WORKFLOW;
    if (workflowEnv !== "false") {
      let workflowContent: string | null = null;
      if (workflowEnv) {
        workflowContent = workflowEnv;
      } else {
        try {
          workflowContent = readFileSync(join(__dirname, "../workflow-templates/default.md"), "utf-8");
        } catch { /* not found */ }
      }
      if (workflowContent) {
        sections.push(`## Development Workflow\n\n${workflowContent}`);
      }
    }

    return sections.join("\n\n");
  }

  getReadyPattern(): RegExp {
    return /Ask anything|ctrl\+p commands/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /rate.?limit|too many requests|429/i, type: "rate_limit", action: "failover", message: "Rate limit reached" },
      { pattern: /auth.*error|unauthorized|401/i, type: "auth_error", action: "pause", message: "Authentication error" },
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    try {
      const f = join(this.instanceDir, "session-id");
      return readFileSync(f, "utf-8").trim() || null;
    } catch { return null; }
  }

  cleanup(config: CliBackendConfig): void {
    // Clean up instance-specific MCP entries and instructions from opencode.json
    try {
      const configPath = join(config.workingDirectory, "opencode.json");
      if (existsSync(configPath)) {
        const oc = JSON.parse(readFileSync(configPath, "utf-8"));
        if (oc.mcp) {
          for (const name of Object.keys(config.mcpServers)) {
            delete oc.mcp[`${name}-${config.instanceName}`];
            delete oc.mcp[name]; // also clean old non-namespaced key
          }
        }
        // Remove fleet instructions reference
        const instructionsPath = join(this.instanceDir, "fleet-instructions.md");
        if (Array.isArray(oc.instructions)) {
          oc.instructions = oc.instructions.filter((p: string) => p !== instructionsPath);
          if (oc.instructions.length === 0) delete oc.instructions;
        }
        writeFileSync(configPath, JSON.stringify(oc, null, 2));
      }
    } catch { /* best effort */ }
  }
}
