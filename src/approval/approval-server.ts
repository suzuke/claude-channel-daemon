import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { MessageBus } from "../channel/message-bus.js";
import type { IpcServer } from "../channel/ipc-bridge.js";

const DANGER_PATTERNS = [
  /\brm\b/,                    // any file deletion
  /\bgit\s+push\b/,           // any push (not just --force)
  /\bgit\s+reset\b/,          // any reset
  /\bgit\s+clean\b/,          // any clean
  /\bgit\s+checkout\s+\./,    // discard changes
  /\bgit\s+restore\b/,        // discard changes
  /\bmv\b/,                    // move/rename files
  /\bdd\b/,
  /\bmkfs\b/,
  /\bsudo\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /(?<!\d)>\s*\/(?:etc|usr|var|bin|sbin|lib|opt|root|System|Library)\b/,  // redirect to system paths (not /tmp, not 2>/dev/null)
  /(?:\/usr)?\/s?bin\/(rm|chmod|chown|mkfs|dd)\b/,  // full path variants
  /\b(?:command|env|builtin)\s+(rm|chmod|chown|sudo)\b/,  // command wrappers
  /\$\(.*\b(rm|dd|mkfs)\b/,  // command substitution with dangerous commands
];

function isSafeTool(toolName: string): boolean {
  if (toolName === "Bash" || toolName.startsWith("Bash(")) return false;
  return true;
}

function isDangerousCommand(command: string): boolean {
  return DANGER_PATTERNS.some(pattern => pattern.test(command));
}

interface ApprovalOptions {
  messageBus: MessageBus;
  port: number;
  /** In topic mode, approval is forwarded via IPC to fleet manager */
  ipcServer?: IpcServer | null;
  topicMode?: boolean;
  /** Instance name — so fleet manager knows which topic to send approval to */
  instanceName?: string;
}

const APPROVAL_TIMEOUT_MS = 120_000;

export class ApprovalServer {
  private server: Server | null = null;
  private messageBus: MessageBus;
  private port: number;
  private ipcServer: IpcServer | null;
  private topicMode: boolean;
  private instanceName: string;
  private token: string;

  constructor(opts: ApprovalOptions) {
    this.messageBus = opts.messageBus;
    this.port = opts.port;
    this.ipcServer = opts.ipcServer ?? null;
    this.topicMode = opts.topicMode ?? false;
    this.instanceName = opts.instanceName ?? "";
    this.token = randomBytes(32).toString("hex");
  }

  getToken(): string {
    return this.token;
  }

  async start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = createServer(async (req, res) => {
        if (req.headers.authorization !== `Bearer ${this.token}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }

        if (req.method !== "POST" || req.url !== "/approve") {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Not found" }));
          return;
        }

        let body = "";
        req.on("data", (chunk) => { body += chunk; });
        req.on("end", async () => {
          try {
            const { tool_name, tool_input } = JSON.parse(body) as {
              tool_name: string;
              tool_input: Record<string, unknown>;
            };

            let permissionDecision: "allow" | "deny";
            let permissionDecisionReason: string | undefined;

            if (tool_name === "Bash" && typeof tool_input?.command === "string" && isDangerousCommand(tool_input.command)) {
              // Dangerous Bash commands → require human approval
              const prompt = `⚠️ ${tool_name}\n\`\`\`\n${tool_input.command}\n\`\`\``;
              const decision = await this.requestApproval(prompt);
              permissionDecision = decision;
              permissionDecisionReason = decision === "allow"
                ? "approved by user"
                : "denied by user";
            } else {
              // Everything else (all tools + normal Bash) → auto-allow
              permissionDecision = "allow";
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision,
                ...(permissionDecisionReason ? { permissionDecisionReason } : {}),
              },
            }));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Bad request" }));
          }
        });
      });

      this.server.on("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        const address = this.server!.address();
        const actualPort = typeof address === "object" && address !== null ? address.port : this.port;
        resolve(actualPort);
      });
    });
  }

  private requestApproval(prompt: string): Promise<"allow" | "deny"> {
    if (this.topicMode && this.ipcServer) {
      return this.requestApprovalViaIpc(prompt);
    }
    return this.requestApprovalViaBus(prompt);
  }

  /** DM mode: use messageBus directly (adapter is registered on this daemon) */
  private async requestApprovalViaBus(prompt: string): Promise<"allow" | "deny"> {
    const result = await this.messageBus.requestApproval(prompt);
    return result.decision === "deny" ? "deny" : "allow";
  }

  /** Topic mode: forward approval request to fleet manager via IPC */
  private requestApprovalViaIpc(prompt: string): Promise<"allow" | "deny"> {
    return new Promise((resolve) => {
      const approvalId = `approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const timeout = setTimeout(() => {
        cleanup();
        resolve("deny");
      }, APPROVAL_TIMEOUT_MS);

      const onMessage = (msg: Record<string, unknown>) => {
        if (msg.type === "fleet_approval_response" && msg.approvalId === approvalId) {
          cleanup();
          resolve(msg.decision === "deny" ? "deny" : "allow");
        }
      };

      const cleanup = () => {
        clearTimeout(timeout);
        this.ipcServer?.removeListener("message", onMessage as (...a: unknown[]) => void);
      };

      this.ipcServer?.on("message", onMessage as (...a: unknown[]) => void);
      this.ipcServer?.broadcast({
        type: "fleet_approval_request",
        approvalId,
        instanceName: this.instanceName,
        prompt,
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = null;
    });
  }
}
