// src/backend/hook-based-approval.ts
import type { ApprovalStrategy } from "./approval-strategy.js";
import { ApprovalServer } from "../approval/approval-server.js";
import type { MessageBus } from "../channel/message-bus.js";
import type { IpcServer } from "../channel/ipc-bridge.js";

export interface HookBasedApprovalOptions {
  messageBus: MessageBus;
  port: number;
  ipcServer?: IpcServer | null;
  topicMode?: boolean;
  instanceName?: string;
}

export class HookBasedApproval implements ApprovalStrategy {
  private server: ApprovalServer;

  constructor(private opts: HookBasedApprovalOptions) {
    this.server = new ApprovalServer({
      messageBus: opts.messageBus,
      port: opts.port,
      ipcServer: opts.ipcServer,
      topicMode: opts.topicMode,
      instanceName: opts.instanceName,
    });
  }

  setup(port: number): { hooks: Record<string, unknown> } {
    return {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: `curl -s -X POST http://127.0.0.1:${port}/approve -H 'Content-Type: application/json' -d @- --max-time 130 --connect-timeout 1 || echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"approval server unreachable"}}'`,
                timeout: 135000,
              },
            ],
          },
        ],
      },
    };
  }

  async start(): Promise<number> {
    return this.server.start();
  }

  async stop(): Promise<void> {
    return this.server.stop();
  }
}
