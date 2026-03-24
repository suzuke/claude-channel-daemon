import { describe, it, expect, vi, afterEach } from "vitest";
import { ApprovalServer } from "../../src/approval/approval-server.js";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    const token = server.getToken();
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/foo" } }),
    });
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(mockBus.requestApproval).not.toHaveBeenCalled();
  });

  it("rejects requests without valid token", async () => {
    const mockBus = { requestApproval: vi.fn() };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0 });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: "Read", tool_input: { file_path: "/tmp/foo" } }),
    });
    expect(res.status).toBe(401);
  });

  it("forwards dangerous bash commands to messageBus for approval", async () => {
    const mockBus = { requestApproval: vi.fn().mockResolvedValue({ decision: "deny", respondedBy: { channelType: "mock", userId: "1" } }) };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0 });
    const port = await server.start();
    const token = server.getToken();
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
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
    const token = server.getToken();
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "sudo npm publish" } }),
    });
    expect(mockBus.requestApproval).toHaveBeenCalled();
  });

  it("records install commands when approved", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    const recordPath = join(tmpDir, "installs.log");
    const mockBus = { requestApproval: vi.fn() };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0, installRecordPath: recordPath });
    const port = await server.start();
    const token = server.getToken();

    // Send an install command (non-dangerous, so auto-approved)
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pip install requests flask" } }),
    });
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");

    // Verify the install was recorded
    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("pip|requests|");
    expect(content).toContain("pip|flask|");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not record install commands when no installRecordPath", async () => {
    const mockBus = { requestApproval: vi.fn() };
    server = new ApprovalServer({ messageBus: mockBus as any, port: 0 });
    const port = await server.start();
    const token = server.getToken();

    // Should not throw even without installRecordPath
    const res = await fetch(`http://127.0.0.1:${port}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ tool_name: "Bash", tool_input: { command: "pip install requests" } }),
    });
    const body = await res.json();
    expect(body.hookSpecificOutput.permissionDecision).toBe("allow");
  });
});
