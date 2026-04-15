import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CliBackend, type CliBackendConfig, type ErrorPattern, type RuntimeDialog, type StartupDialog, resolveBinary } from "./types.js";
import { appendWithMarker, removeMarker } from "./marker-utils.js";

const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;

export class CodexBackend implements CliBackend {
  readonly binaryName = "codex";
  private binaryPath: string;

  constructor(private instanceDir: string) {
    this.binaryPath = resolveBinary("codex");
  }

  buildCommand(config: CliBackendConfig): string {
    const approvalFlag = config.skipPermissions !== false
      ? "--dangerously-bypass-approvals-and-sandbox"
      : "--full-auto";

    // `codex resume --last` resumes the most recent session for the current
    // working directory. Each AgEnD instance has a unique working_directory,
    // so sessions are per-instance scoped and won't collide.
    // If no prior session exists (first launch), Codex falls back to a fresh session.
    let cmd: string;
    if (config.skipResume) {
      cmd = `${this.binaryPath} ${approvalFlag}`;
    } else {
      cmd = `${this.binaryPath} resume --last ${approvalFlag}`;
    }
    if (config.model) cmd += ` -c model="${config.model}"`;
    return cmd;
  }

  writeConfig(config: CliBackendConfig): void {
    // Codex stores MCP config globally in ~/.codex/config.toml.
    // Use execFileSync (no shell) to avoid escaping issues with env values
    // containing JSON (e.g. AGEND_DECISIONS). Use namespaced key to avoid
    // conflicts when multiple Codex instances run simultaneously.
    for (const [name, entry] of Object.entries(config.mcpServers)) {
      const mcpName = `${name}-${config.instanceName}`;
      const allEnv = { ...entry.env, AGEND_INSTANCE_NAME: config.instanceName };
      const args = ["mcp", "add", mcpName];
      for (const [k, v] of Object.entries(allEnv)) {
        args.push("--env", `${k}=${v}`);
      }
      args.push("--", entry.command, ...entry.args);
      // Remove existing entry first (codex mcp add fails if name exists)
      try { execFileSync(this.binaryPath, ["mcp", "remove", mcpName], { stdio: "ignore" }); } catch { /* may not exist */ }
      try { execFileSync(this.binaryPath, args, { stdio: "ignore" }); } catch { /* best effort */ }
    }
    // Clean up old non-namespaced key if present (one-time migration)
    try { execFileSync(this.binaryPath, ["mcp", "remove", "agend"], { stdio: "ignore" }); } catch { /* may not exist */ }

    // Write fleet instructions into AGENTS.md (additive via marker block)
    if (config.instructions) {
      try {
        const agentsMd = join(config.workingDirectory, "AGENTS.md");
        appendWithMarker(agentsMd, config.instanceName, config.instructions);
        // Warn if file exceeds Codex's project_doc_max_bytes limit
        try {
          const size = statSync(agentsMd).size;
          if (size > CODEX_PROJECT_DOC_MAX_BYTES) {
            console.warn(`[agend] AGENTS.md is ${size} bytes, exceeds Codex limit of ${CODEX_PROJECT_DOC_MAX_BYTES} — instructions may be truncated`);
          }
        } catch { /* stat failed — skip size check */ }
      } catch { /* best effort */ }
    }
  }

  preTrust(workDir: string): void {
    const configPath = join(homedir(), ".codex", "config.toml");
    let content = "";
    try { content = readFileSync(configPath, "utf-8"); } catch {}

    const section = `[projects."${workDir}"]`;
    if (content.includes(section)) return;

    mkdirSync(dirname(configPath), { recursive: true });
    appendFileSync(configPath, `\n${section}\ntrust_level = "trusted"\n`);
  }

  getReadyPattern(): RegExp {
    return /% left|OpenAI Codex/m;
  }

  getErrorPatterns(): ErrorPattern[] {
    return [
      { pattern: /rate limit|429 Too Many Requests/i, type: "rate_limit", action: "failover", message: "OpenAI rate limit reached" },
      { pattern: /authentication|401 Unauthorized/i, type: "auth_error", action: "pause", message: "OpenAI authentication error" },
      { pattern: /insufficient_quota|billing/i, type: "quota", action: "pause", message: "OpenAI quota exceeded" },
      { pattern: /you've hit your usage limit/i, type: "quota", action: "pause", message: "Codex usage limit reached — upgrade plan required" },
      { pattern: /less than \d+% of your weekly limit/i, type: "quota", action: "notify", message: "Codex weekly limit running low" },
    ];
  }

  getStartupDialogs(): StartupDialog[] {
    return [
      { pattern: /Do you trust the files in this folder/i, keys: ["Enter"], description: "Codex trust dialog" },
      { pattern: /Yes, continue/i, keys: ["Enter"], description: "Codex 'Yes, continue' confirmation" },
    ];
  }

  getRuntimeDialogs(): RuntimeDialog[] {
    return [
      {
        // Codex shows a model switch dialog when approaching rate limits.
        // Auto-select "Keep current model (never show again)" — option 3.
        pattern: /Approaching rate limits[\s\S]*Switch to.*for lower credit/m,
        keys: ["Down", "Down", "Enter"],
        description: "Codex rate limit model switch dialog",
      },
    ];
  }

  getContextUsage(): number | null {
    return null;
  }

  getSessionId(): string | null {
    // Codex manages sessions internally via SQLite (~/.codex/state_5.sqlite).
    // `resume --last` handles session selection by CWD automatically.
    return null;
  }

  getQuitCommand(): string { return "/quit"; }

  cleanup(config: CliBackendConfig): void {
    for (const name of Object.keys(config.mcpServers)) {
      const mcpName = `${name}-${config.instanceName}`;
      try { execFileSync(this.binaryPath, ["mcp", "remove", mcpName], { stdio: "ignore" }); } catch { /* best effort */ }
    }

    // Remove fleet instructions marker block from AGENTS.md
    try {
      const agentsMd = join(config.workingDirectory, "AGENTS.md");
      const isEmpty = removeMarker(agentsMd, config.instanceName);
      if (isEmpty && existsSync(agentsMd)) unlinkSync(agentsMd);
    } catch { /* best effort */ }

    // Remove trust entry from ~/.codex/config.toml
    try {
      const configPath = join(homedir(), ".codex", "config.toml");
      const content = readFileSync(configPath, "utf-8");
      const escaped = config.workingDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\n?\\[projects\\."${escaped}"\\]\\ntrust_level = "trusted"\\n?`);
      if (re.test(content)) {
        writeFileSync(configPath, content.replace(re, "\n"));
      }
    } catch { /* best effort */ }
  }
}
