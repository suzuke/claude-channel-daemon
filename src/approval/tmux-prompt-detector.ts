import { readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
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

// ── Prompt classification ────────────────────────────────────────────────────

export type PromptType =
  | "permission"       // Tool use permission — forward to user
  | "settings_error"   // Settings file error — auto-continue
  | "dev_channels"     // Development channels warning — auto-confirm
  | "mcp_trust"        // New MCP server trust — auto-confirm
  | "file_creation"    // SKILL.md, AGENTS.md etc. — auto-deny
  | "unknown";         // Unrecognized — forward to user

/** Detect whether text contains a Claude Code interactive prompt */
export function detectInteractivePrompt(text: string): boolean {
  const clean = stripAnsi(text);
  // All Claude Code interactive prompts have numbered options like "1." or "❯ 1."
  // combined with "Esc to cancel" or "Enter to confirm"
  const hasNumberedOption = /[❯>]?\s*1\.\s/.test(clean);
  const hasPromptChrome = /Esc to cancel|Enter to confirm/.test(clean);
  return hasNumberedOption && hasPromptChrome;
}

/** Classify a detected prompt to determine handling strategy */
export function classifyPrompt(text: string): PromptType {
  const clean = stripAnsi(text);

  // Permission / tool use: "Do you want to proceed?" with Yes/No
  if (/Do you want to proceed/i.test(clean) && /\bYes\b/.test(clean) && /\bNo\b/.test(clean)) {
    return "permission";
  }

  // Settings error: has "Settings Error" or "Continue without these settings"
  if (/Settings Error/i.test(clean) || /Continue without these settings/i.test(clean)) {
    return "settings_error";
  }

  // Dev channels: "I am using this for local development"
  if (/I am using this for local development/i.test(clean)) {
    return "dev_channels";
  }

  // MCP trust: "New MCP server found" or "Use this and all future"
  if (/New MCP server found/i.test(clean) || /Use this and all future/i.test(clean)) {
    return "mcp_trust";
  }

  // File creation: "Do you want to create"
  if (/Do you want to create/i.test(clean)) {
    return "file_creation";
  }

  return "unknown";
}

// ── Kept for backwards compat with tests ─────────────────────────────────────

export function detectPermissionPrompt(text: string): boolean {
  const clean = stripAnsi(text);
  return /1\.\s*Yes\b/.test(clean) && /3\.\s*No\b/.test(clean);
}

/**
 * Extract tool name from Claude Code permission prompt text.
 * Returns the permission-format tool name (e.g. "mcp__puppeteer__puppeteer_navigate").
 */
export function extractToolPattern(text: string): string | null {
  const clean = stripAnsi(text);
  // "don't" may appear as don't, don.t, or dont (apostrophe stripped by terminal)
  const m = clean.match(/don.?t ask again for\s+(.+?)\s+commands?\s+in\b/i);
  if (!m) return null;

  const display = m[1].trim();
  // MCP tool: "server - tool_name" → "mcp__server__tool_name"
  const mcpMatch = display.match(/^(\S+)\s*-\s*(\S+)$/);
  if (mcpMatch) {
    return `mcp__${mcpMatch[1]}__${mcpMatch[2]}`;
  }
  // Built-in tool: "Bash" → "Bash(*)"
  return `${display}(*)`;
}

/** Build a clean prompt message for Telegram display */
export function formatPromptForDisplay(text: string): string {
  const clean = stripAnsi(text)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Tool use prompt: extract tool name and args
  const toolMatch = clean.match(/(\S+\s*-\s*\S+)\s*\(([^)]*)\)\s*\(MCP\)/i)
                 ?? clean.match(/(\S+)\s*\(([^)]*)\)/);
  if (toolMatch) {
    const tool = toolMatch[1].trim();
    const args = toolMatch[2].trim();
    const truncatedArgs = args.length > 200 ? args.slice(0, 200) + "…" : args;
    return `⚠️ ${tool}\n\`\`\`\n${truncatedArgs}\n\`\`\``;
  }

  // Fallback: cleaned text, truncated
  const truncated = clean.length > 500 ? clean.slice(0, 500) + "…" : clean;
  return `⚠️ Prompt\n${truncated}`;
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

// ── Prompt handler helpers ───────────────────────────────────────────────────

/**
 * Select option N in a Claude Code interactive menu.
 * Option 1 is pre-selected (❯), so:
 *   option 1 → Enter
 *   option 2 → Down + Enter
 *   option 3 → Down + Down + Enter
 */
async function selectOption(tmux: TmuxManager, option: number): Promise<void> {
  for (let i = 1; i < option; i++) {
    await tmux.sendSpecialKey("Down");
  }
  await tmux.sendSpecialKey("Enter");
}

async function pressEscape(tmux: TmuxManager): Promise<void> {
  await tmux.sendSpecialKey("Escape");
}

// ── Main detector ────────────────────────────────────────────────────────────

export class TmuxPromptDetector {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private byteOffset = 0;
  private pendingApproval = false;

  constructor(
    private outputLogPath: string,
    private tmux: TmuxManager,
    private approvalFn: (prompt: string) => Promise<ApprovalResponse>,
    private logger: { info(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void },
    private instanceDir?: string,
  ) {}

  startPolling(intervalMs = 2000): void {
    if (this.pollTimer !== null) return;

    // Skip existing content — only detect prompts written after we start
    try {
      this.byteOffset = statSync(this.outputLogPath).size;
    } catch { /* file may not exist yet */ }

    this.pollTimer = setInterval(async () => {
      // Read new content from log file
      let newContent: string;
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

        newContent = buf.subarray(0, bytesRead).toString("utf8");
        this.byteOffset += bytesRead;
      } catch {
        // File may not exist yet (ENOENT); silently ignore
        return;
      }

      // Detect and handle prompts
      try {
        if (!detectInteractivePrompt(newContent) || this.pendingApproval) return;

        const promptType = classifyPrompt(newContent);
        this.logger.info({ promptType }, "TmuxPromptDetector: interactive prompt detected");

        switch (promptType) {
          case "dev_channels":
          case "mcp_trust":
            // Auto-confirm: option 1 is already selected
            await selectOption(this.tmux, 1);
            this.logger.info({ promptType }, "TmuxPromptDetector: auto-confirmed");
            break;

          case "settings_error":
            // "Continue without these settings" is option 2
            await selectOption(this.tmux, 2);
            this.logger.info("TmuxPromptDetector: auto-continued past settings error");
            break;

          case "file_creation":
            // Auto-deny file creation prompts (SKILL.md etc.)
            await pressEscape(this.tmux);
            this.logger.info("TmuxPromptDetector: auto-denied file creation");
            break;

          case "permission":
            // Forward to user via Telegram
            this.pendingApproval = true;
            try {
              const toolPattern = extractToolPattern(newContent);
              const cleanPrompt = formatPromptForDisplay(newContent);
              const result = await this.approvalFn(cleanPrompt);
              this.logger.info({ decision: result.decision }, "TmuxPromptDetector: user responded");

              if (result.decision === "always_allow") {
                await selectOption(this.tmux, 2); // "Yes, and don't ask again"
                if (toolPattern && this.instanceDir) {
                  saveToolToAllowlist(this.instanceDir, toolPattern);
                  this.logger.info({ toolPattern }, "TmuxPromptDetector: added to allowlist");
                }
              } else if (result.decision === "approve") {
                await selectOption(this.tmux, 1); // "Yes"
              } else {
                await selectOption(this.tmux, 3); // "No"
              }
            } catch (err) {
              this.logger.warn("TmuxPromptDetector: approval error, denying", err);
              await pressEscape(this.tmux);
            } finally {
              this.pendingApproval = false;
            }
            break;

          case "unknown":
          default:
            // Forward unknown prompts to user too
            this.pendingApproval = true;
            try {
              const cleanPrompt = formatPromptForDisplay(newContent);
              const result = await this.approvalFn(cleanPrompt);
              this.logger.info({ decision: result.decision }, "TmuxPromptDetector: user responded to unknown prompt");
              if (result.decision === "deny") {
                await pressEscape(this.tmux);
              } else {
                await selectOption(this.tmux, 1);
              }
            } catch (err) {
              this.logger.error({ err }, "Unknown prompt approval error");
              await pressEscape(this.tmux);
            } finally {
              this.pendingApproval = false;
            }
            break;
        }
      } catch (err) {
        this.logger.error({ err }, "Prompt detection error");
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
