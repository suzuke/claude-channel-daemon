import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface FleetInstructionsParams {
  instanceName: string;
  workingDirectory: string;
  displayName?: string;
  description?: string;
  customPrompt?: string;
  workflow?: string | false;
  decisions?: { title: string; content: string }[];
}

export function buildFleetInstructions(params: FleetInstructionsParams): string {
  const { instanceName, workingDirectory, displayName, description, customPrompt } = params;
  const sections: string[] = [];

  // ── Identity ──
  sections.push(`# AgEnD Fleet Context\nYou are **${instanceName}**, an instance in an AgEnD fleet.\nYour working directory is \`${workingDirectory}\`.`);
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
  if (params.workflow !== false) {
    let workflowContent: string | null = null;
    if (params.workflow) {
      workflowContent = params.workflow;
    } else {
      try {
        const here = dirname(fileURLToPath(import.meta.url));
        workflowContent = readFileSync(join(here, "workflow-templates/default.md"), "utf-8");
      } catch { /* template not found — skip */ }
    }
    if (workflowContent) {
      sections.push(`## Development Workflow\n\n${workflowContent}`);
    }
  }

  // ── Active decisions ──
  const decisions = params.decisions;
  if (decisions && decisions.length > 0) {
    const MAX = 15;
    const lines = decisions.slice(0, MAX).map(d => {
      const firstLine = (d.content ?? "").split(/[.\n]/)[0].trim().slice(0, 120);
      return `- **${d.title}**: ${firstLine}`;
    });
    if (decisions.length > MAX) {
      lines.push(`- *(${decisions.length - MAX} more — use \`list_decisions\` to see all)*`);
    }
    sections.push(`## Active Decisions\n\n${lines.join("\n")}`);
  }

  // ── Custom user prompt ──
  if (customPrompt) {
    sections.push(customPrompt);
  }

  return sections.join("\n\n");
}
