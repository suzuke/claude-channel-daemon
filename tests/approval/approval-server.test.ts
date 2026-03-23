import { describe, it, expect, vi, afterEach } from "vitest";
import { ApprovalServer } from "../../src/approval/approval-server.js";

describe("ApprovalServer", () => {
  let server: ApprovalServer;
  afterEach(async () => { await server?.stop(); });

  it("starts on random port", async () => {
    const mockBus = { requestApproval: vi.fn().mockResolvedValue({ decision: "approve", respondedBy: { channelType: "mock", userId: "1" } }) };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0 });
    const port = await server.start();
    expect(port).toBeGreaterThan(0);
  });

  it("auto-approves safe tools", async () => {
    const mockBus = { requestApproval: vi.fn() };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0 });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/foo" } }),
    });
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(mockBus.requestApproval).not.toHaveBeenCalled();
  });

  it("forwards dangerous bash commands to messageBus for approval", async () => {
    const mockBus = { requestApproval: vi.fn().mockResolvedValue({ decision: "deny", respondedBy: { channelType: "mock", userId: "1" } }) };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0 });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "rm -rf /" } }),
    });
    const body = await res.json();
    expect(mockBus.requestApproval).toHaveBeenCalled();
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("forwards unknown tools to messageBus", async () => {
    const mockBus = { requestApproval: vi.fn().mockResolvedValue({ decision: "approve", respondedBy: { channelType: "tg", userId: "1" } }) };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0 });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo npm publish" } }),
    });
    expect(mockBus.requestApproval).toHaveBeenCalled();
  });
});
