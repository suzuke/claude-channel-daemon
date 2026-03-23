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
  // MCP tool: "server - tool_name" → "mcp__server__tool_name"
  // (Claude Code MCP rules don't support parenthesized patterns)
  const mcpMatch = display.match(/^(\S+)\s*-\s*(\S+)$/);
  if (mcpMatch) {
    return `mcp__${mcpMatch[1]}__${mcpMatch[2]}`;
  }
  // Built-in tool: "Bash" → "Bash(*)"
  return `${display}(*)`;
}

/**
 * Build a clean, human-readable prompt from raw terminal output.
 * Extracts tool name and description for display in Telegram.
 */
export function formatPromptForDisplay(text: string): string {
  const clean = stripAnsi(text)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Try to extract structured info
  // Pattern: "puppeteer - puppeteer_navigate(url: "...")" or "Bash(command)"
  const toolMatch = clean.match(/(\S+\s*-\s*\S+)\s*\(([^)]*)\)\s*\(MCP\)/i)
                 ?? clean.match(/(\S+)\s*\(([^)]*)\)/);
  if (toolMatch) {
    const tool = toolMatch[1].trim();
    const args = toolMatch[2].trim();
    const truncatedArgs = args.length > 200 ? args.slice(0, 200) + "…" : args;
    return `⚠️ ${tool}\n\`\`\`\n${truncatedArgs}\n\`\`\``;
  }

  // Fallback: just return cleaned text, truncated
  const truncated = clean.length > 500 ? clean.slice(0, 500) + "…" : clean;
  return `⚠️ Permission prompt\n${truncated}`;
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
  /** True while an approval request is in-flight — suppresses duplicate detections */
  private pendingApproval = false;

  constructor(
    private outputLogPath: string,
    private tmux: TmuxManager,
    private approvalFn: (prompt: string) => Promise<ApprovalResponse>,
    private logger: { info(...args: any[]): void; warn(...args: any[]): void },
    private instanceDir?: string,
  ) {}

  startPolling(intervalMs = 2000): void {
    if (this.pollTimer !== null) return;

    // Skip existing content — only detect prompts written after we start polling
    try {
      this.byteOffset = statSync(this.outputLogPath).size;
    } catch { /* file may not exist yet */ }

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

        if (detectPermissionPrompt(newContent) && !this.pendingApproval) {
          this.logger.info("TmuxPromptDetector: permission prompt detected");
          this.pendingApproval = true;
          const toolPattern = extractToolPattern(newContent);
          const cleanPrompt = formatPromptForDisplay(newContent);
          try {
            const result = await this.approvalFn(cleanPrompt);
            if (result.decision === "always_allow") {
              // Navigate to option 2 and confirm
              await this.tmux.sendSpecialKey("Down");
              await this.tmux.sendSpecialKey("Enter");
              // Persist the tool pattern so writeSettings includes it next time
              if (toolPattern && this.instanceDir) {
                saveToolToAllowlist(this.instanceDir, toolPattern);
                this.logger.info(`TmuxPromptDetector: added ${toolPattern} to allowlist`);
              }
            } else if (result.decision === "approve") {
              // Option 1 is already selected by default
              await this.tmux.sendSpecialKey("Enter");
            } else {
              // Navigate to option 3 (No) and confirm
              await this.tmux.sendSpecialKey("Down");
              await this.tmux.sendSpecialKey("Down");
              await this.tmux.sendSpecialKey("Enter");
            }
          } catch (err) {
            this.logger.warn("TmuxPromptDetector: approvalFn error", err);
            await this.tmux.sendKeys("3");
          } finally {
            this.pendingApproval = false;
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
