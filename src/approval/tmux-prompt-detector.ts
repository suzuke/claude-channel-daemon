import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { TmuxManager } from "../tmux-manager.js";
import type { ApprovalResponse } from "../channel/types.js";

/** Strip ANSI escape codes from terminal output */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[\d*C/g, " ")            // cursor forward → space
             .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")  // other CSI sequences
             .replace(/\x1b\][^\x07]*\x07/g, "")      // OSC sequences
             .replace(/\x1b[()][0-9A-B]/g, "")        // charset switches
             .replace(/[\x00-\x08\x0e-\x1f]/g, "");   // misc control chars
}

export function detectPermissionPrompt(text: string): boolean {
  const clean = stripAnsi(text);
  // Claude Code permission prompt: "1. Yes" + "3. No" (with flexible spacing)
  return /1\.\s*Yes\b/.test(clean) && /3\.\s*No\b/.test(clean);
}

/**
 * Extract tool name from Claude Code permission prompt text.
 * Pattern: "don't ask again for <tool> commands in"
 * Returns the permission-format tool name (e.g. "mcp__puppeteer__puppeteer_navigate(*)").
 */
export function extractToolPattern(text: string): string | null {
  const clean = stripAnsi(text);
  // Match: "don't ask again for <tool_display_name> commands in"
  // Tool display: "server - tool_name" for MCP, or just "ToolName" for built-in
  // "don't" may appear as don't, don.t, or dont (apostrophe stripped by terminal)
  const m = clean.match(/don.?t ask again for\s+(.+?)\s+commands?\s+in\b/i);
  if (!m) return null;

  const display = m[1].trim();
  // MCP tool: "server - tool_name" → "mcp__server__tool_name(*)"
  const mcpMatch = display.match(/^(\S+)\s*-\s*(\S+)$/);
  if (mcpMatch) {
    return `mcp__${mcpMatch[1]}__${mcpMatch[2]}(*)`;
  }
  // Built-in tool: "Bash" → "Bash(*)"
  return `${display}(*)`;
}

// ── Persistent tool allowlist ────────────────────────────────────────────────

const ALLOWLIST_FILE = "tool-allowlist.json";

export function loadToolAllowlist(instanceDir: string): string[] {
  const p = join(instanceDir, ALLOWLIST_FILE);
  if (!existsSync(p)) return [];
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

export function saveToolToAllowlist(instanceDir: string, pattern: string): void {
  const list = loadToolAllowlist(instanceDir);
  if (!list.includes(pattern)) {
    list.push(pattern);
    writeFileSync(join(instanceDir, ALLOWLIST_FILE), JSON.stringify(list, null, 2));
  }
}

// ── Prompt detector ──────────────────────────────────────────────────────────

export class TmuxPromptDetector {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private byteOffset = 0;

  constructor(
    private outputLogPath: string,
    private tmux: TmuxManager,
    private approvalFn: (prompt: string) => Promise<ApprovalResponse>,
    private logger: { info(...args: any[]): void; warn(...args: any[]): void },
    private instanceDir?: string,
  ) {}

  startPolling(intervalMs = 2000): void {
    if (this.pollTimer !== null) return;

    this.pollTimer = setInterval(async () => {
      try {
        const stat = statSync(this.outputLogPath);
        const fileSize = stat.size;

        if (fileSize <= this.byteOffset) return;

        const buf = Buffer.alloc(fileSize - this.byteOffset);
        const fd = await import("node:fs").then(fs => fs.openSync(this.outputLogPath, "r"));
        const { readSync, closeSync } = await import("node:fs");
        const bytesRead = readSync(fd, buf, 0, buf.length, this.byteOffset);
        closeSync(fd);

        if (bytesRead <= 0) return;

        const newContent = buf.subarray(0, bytesRead).toString("utf8");
        this.byteOffset += bytesRead;

        if (detectPermissionPrompt(newContent)) {
          this.logger.info("TmuxPromptDetector: permission prompt detected");
          const toolPattern = extractToolPattern(newContent);
          try {
            const result = await this.approvalFn(newContent);
            if (result.decision === "always_allow") {
              // Send "2" = "Yes, and don't ask again"
              await this.tmux.sendKeys("2");
              // Persist the tool pattern so writeSettings includes it next time
              if (toolPattern && this.instanceDir) {
                saveToolToAllowlist(this.instanceDir, toolPattern);
                this.logger.info(`TmuxPromptDetector: added ${toolPattern} to allowlist`);
              }
            } else if (result.decision === "approve") {
              await this.tmux.sendKeys("1");
            } else {
              await this.tmux.sendKeys("3");
            }
          } catch (err) {
            this.logger.warn("TmuxPromptDetector: approvalFn error", err);
            await this.tmux.sendKeys("3");
          }
        }
      } catch (err) {
        // File may not exist yet; ignore
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
