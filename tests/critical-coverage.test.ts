import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";

// ── 1. Backend ready patterns ───────────────────────────────────────────

describe("Backend ready patterns", () => {
  it("Claude Code matches ❯ prompt", async () => {
    const { ClaudeCodeBackend } = await import("../src/backend/claude-code.js");
    const backend = new ClaudeCodeBackend("/tmp/test");
    const pattern = backend.getReadyPattern();
    expect(pattern.test("❯")).toBe(true);
    expect(pattern.test("something ok")).toBe(true);
    expect(pattern.test("Loading...")).toBe(false);
  });

  it("Codex matches ready screen with % left", async () => {
    const { CodexBackend } = await import("../src/backend/codex.js");
    const backend = new CodexBackend("/tmp/test");
    const pattern = backend.getReadyPattern();
    expect(pattern.test("gpt-5.4 default · 100% left · ~/Documents")).toBe(true);
    expect(pattern.test("OpenAI Codex (v0.117.0)")).toBe(true);
    // Must NOT match trust dialog's ›
    expect(pattern.test("› 1. Yes, continue")).toBe(false);
  });

  it("Gemini matches YOLO mode prompt", async () => {
    const { GeminiCliBackend } = await import("../src/backend/gemini-cli.js");
    const backend = new GeminiCliBackend("/tmp/test");
    const pattern = backend.getReadyPattern();
    expect(pattern.test("* Type your message or @path/to/file")).toBe(true);
    expect(pattern.test("? for shortcuts")).toBe(true);
    expect(pattern.test("Loading model...")).toBe(false);
  });

  it("OpenCode matches TUI ready screen", async () => {
    const { OpenCodeBackend } = await import("../src/backend/opencode.js");
    const backend = new OpenCodeBackend("/tmp/test");
    const pattern = backend.getReadyPattern();
    expect(pattern.test("Ask anything or type / for commands")).toBe(true);
    expect(pattern.test("ctrl+p commands")).toBe(true);
    expect(pattern.test("Connecting...")).toBe(false);
  });
});

// ── 2. Dialog detection patterns ────────────────────────────────────────

describe("Dialog detection patterns", () => {
  // These patterns come from daemon.ts dismissDialogsUntilReady
  const dialogPattern = /No, exit|No, quit|Don't trust|Trust folder|I accept|I trust|Yes, continue/i;
  const noSelectedPattern = /[❯›]\s*\d+\.\s*No/m;
  const geminiDontTrust = /[❯›]\s*Don't trust/m;

  it("detects Claude trust dialog", () => {
    const pane = "Do you trust the files in this folder?\n❯ 1. No, exit\n  2. Yes, I trust this folder";
    expect(dialogPattern.test(pane)).toBe(true);
    expect(noSelectedPattern.test(pane)).toBe(true);
  });

  it("detects Codex trust dialog", () => {
    const pane = "Do you trust the contents of this directory?\n› 1. Yes, continue\n  2. No, quit";
    expect(dialogPattern.test(pane)).toBe(true);
    // Codex defaults to Yes (option 1), so No is not selected
    expect(noSelectedPattern.test(pane)).toBe(false);
  });

  it("detects Gemini trust dialog", () => {
    const pane = "Do you trust the files in this folder?\n  Trust folder (myproject)\n  Trust parent folder (Documents)\n› Don't trust";
    expect(dialogPattern.test(pane)).toBe(true);
    expect(geminiDontTrust.test(pane)).toBe(true);
  });
});

// ── 3. Cost-guard rotation with null/0 ──────────────────────────────────

describe("CostGuard rotation detection", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-rotation-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does NOT trigger rotation when cost is 0 (legitimate zero)", async () => {
    const { CostGuard } = await import("../src/cost-guard.js");
    const { EventLog } = await import("../src/event-log.js");
    const eventLog = new EventLog(join(tmpDir, "events.db"));
    const guard = new CostGuard({ daily_limit_usd: 10, warn_at_percentage: 80, timezone: "UTC" }, eventLog);

    guard.updateCost("inst", 0); // first report: 0
    guard.updateCost("inst", 0); // second report: still 0 → should NOT snapshot
    expect(guard.getDailyCostCents("inst")).toBe(0);

    // Verify no snapshot event was logged
    const events = eventLog.query({ instance: "inst", type: "cost_snapshot" });
    expect(events).toHaveLength(0);

    guard.stop();
    eventLog.close();
  });

  it("triggers rotation when cost drops from positive to lower positive", async () => {
    const { CostGuard } = await import("../src/cost-guard.js");
    const { EventLog } = await import("../src/event-log.js");
    const eventLog = new EventLog(join(tmpDir, "events.db"));
    const guard = new CostGuard({ daily_limit_usd: 10, warn_at_percentage: 80, timezone: "UTC" }, eventLog);

    guard.updateCost("inst", 5.00); // session cost = $5
    guard.updateCost("inst", 1.00); // cost dropped → rotation detected

    const events = eventLog.query({ instance: "inst", type: "cost_snapshot" });
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ session_cost_usd: 5.00 });

    // Accumulated: $5 (snapshot) + $1 (new session) = $6
    expect(guard.getDailyCostCents("inst")).toBe(600);

    guard.stop();
    eventLog.close();
  });

  it("accumulates correctly across multiple rotations", async () => {
    const { CostGuard } = await import("../src/cost-guard.js");
    const { EventLog } = await import("../src/event-log.js");
    const eventLog = new EventLog(join(tmpDir, "events.db"));
    const guard = new CostGuard({ daily_limit_usd: 100, warn_at_percentage: 80, timezone: "UTC" }, eventLog);

    guard.updateCost("inst", 3.00); // session 1
    guard.updateCost("inst", 1.00); // rotation → snapshot $3
    guard.updateCost("inst", 2.00); // session 2
    guard.updateCost("inst", 0.50); // rotation → snapshot $2

    // Total: $3 + $2 + $0.50 = $5.50 = 550 cents
    expect(guard.getDailyCostCents("inst")).toBe(550);

    guard.stop();
    eventLog.close();
  });
});

// ── 4. Outbound handlers dispatch ───────────────────────────────────────

describe("outbound-handlers", () => {
  it("outboundHandlers map contains all expected tools", async () => {
    const { outboundHandlers } = await import("../src/outbound-handlers.js");
    const expectedTools = [
      "send_to_instance", "list_instances", "request_information",
      "delegate_task", "report_result", "describe_instance",
      "start_instance", "create_instance", "delete_instance",
    ];
    for (const tool of expectedTools) {
      expect(outboundHandlers.has(tool), `Missing handler for: ${tool}`).toBe(true);
    }
  });

  it("wrapAsSend-based handlers do NOT mutate input args", async () => {
    const { outboundHandlers } = await import("../src/outbound-handlers.js");

    // Mock minimal context
    const sentMessages: unknown[] = [];
    const mockIpc = { send: (msg: unknown) => sentMessages.push(msg) };
    const ctx = {
      fleetConfig: { instances: { target: { working_directory: "/tmp" } } },
      adapter: {},
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      routing: { resolve: () => undefined },
      instanceIpcClients: new Map([["target", mockIpc]]),
      lifecycle: { daemons: new Map() },
      sessionRegistry: new Map(),
      lastActivityMs: () => 0,
      startInstance: vi.fn(),
      connectIpcToInstance: vi.fn(),
    } as any;

    const originalArgs = {
      target_instance: "target",
      question: "What is the status?",
      context: "Testing",
    };
    const argsCopy = { ...originalArgs };

    const handler = outboundHandlers.get("request_information")!;
    const respond = vi.fn();
    await handler(ctx, originalArgs, respond, {
      instanceName: "sender",
      requestId: 1,
      fleetRequestId: undefined,
      senderSessionName: undefined,
    });

    // Original args must not be mutated
    expect(originalArgs).toEqual(argsCopy);
  });
});

// ── 5. safeHandler edge case ────────────────────────────────────────────

describe("safeHandler edge cases", () => {
  it("catches rejection from function that returns Promise but is not declared async", async () => {
    const { safeHandler } = await import("../src/safe-async.js");
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } as any;

    // Function returns a Promise (via explicit return) but is not async
    const fn = () => Promise.reject(new Error("sneaky rejection"));
    const wrapped = safeHandler(fn, logger, "sneaky");
    wrapped();

    await new Promise(r => setTimeout(r, 10));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ context: "sneaky" }),
      "Unhandled error in async handler",
    );
  });

  // Note: if a callback calls an async function without return/await,
  // safeHandler cannot catch the rejection — the Promise is lost.
  // This is why all fleet-manager listeners were changed to async/await
  // in the P0-1 Codex review fix (commit 5531488).
});
