/**
 * Feature #24 regression: cost-guard pre-check at outbound dispatch.
 *
 * Operator-mandated coverage of three states:
 *   (a) costGuard.isLimited(target) === true  → immediate warning, no dispatch
 *   (b) costGuard.isLimited(target) === false → normal dispatch
 *   (c) ctx.costGuard === null               → graceful fallback, no error
 *
 * Verified for both `send_to_instance` (direct) and `delegate_task` (which
 * funnels through `sendToInstance` via wrapAsSend with request_kind="task").
 */
import { describe, it, expect, vi } from "vitest";
import { outboundHandlers } from "../src/outbound-handlers.js";

interface MockIpcChannel {
  messages: unknown[];
  ipc: { send: (msg: unknown) => void };
}

function mockIpc(): MockIpcChannel {
  const messages: unknown[] = [];
  return { messages, ipc: { send: (msg) => { messages.push(msg); } } };
}

interface CostGuardMock {
  isLimited: ReturnType<typeof vi.fn>;
  getLimitCents: ReturnType<typeof vi.fn>;
  getDailyCostCents: ReturnType<typeof vi.fn>;
}

function mockCostGuard(opts: { limited: boolean; limitUsd?: number }): CostGuardMock {
  const limitCents = (opts.limitUsd ?? 5) * 100;
  return {
    isLimited: vi.fn(() => opts.limited),
    getLimitCents: vi.fn(() => limitCents),
    getDailyCostCents: vi.fn(() => opts.limited ? limitCents + 100 : 0),
  };
}

function makeCtx(costGuard: CostGuardMock | null) {
  const targetIpc = mockIpc();
  const senderIpc = mockIpc();
  return {
    target: targetIpc,
    sender: senderIpc,
    ctx: {
      fleetConfig: {
        instances: {
          sender: { working_directory: "/tmp/s" },
          target: { working_directory: "/tmp/t" },
        },
      },
      adapter: null,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      routing: { resolve: () => undefined },
      instanceIpcClients: new Map([
        ["sender", senderIpc.ipc],
        ["target", targetIpc.ipc],
      ]),
      lifecycle: { daemons: new Map() },
      sessionRegistry: new Map(),
      eventLog: null,
      costGuard,
      lastActivityMs: () => 0,
      startInstance: vi.fn(),
      connectIpcToInstance: vi.fn(),
    } as any,
  };
}

const meta = {
  instanceName: "sender",
  requestId: 1,
  fleetRequestId: undefined,
  senderSessionName: undefined,
};

describe("Feature #24 — cost-guard pre-check at outbound dispatch", () => {
  describe("send_to_instance", () => {
    it("(a) target is limited → immediate warning result, no dispatch", async () => {
      const cg = mockCostGuard({ limited: true, limitUsd: 5 });
      const { ctx, target } = makeCtx(cg);
      const handler = outboundHandlers.get("send_to_instance")!;
      const respond = vi.fn();

      await handler(ctx, { instance_name: "target", message: "hi" }, respond, meta);

      expect(cg.isLimited).toHaveBeenCalledWith("target");
      expect(target.messages).toHaveLength(0);
      expect(respond).toHaveBeenCalledTimes(1);
      const [result, error] = respond.mock.calls[0];
      expect(result).toBeNull();
      expect(error).toContain("cost-guard");
      expect(error).toContain("'target'");
      expect(error).toContain("$5.00");
    });

    it("(b) target is not limited → normal dispatch", async () => {
      const cg = mockCostGuard({ limited: false, limitUsd: 5 });
      const { ctx, target } = makeCtx(cg);
      const handler = outboundHandlers.get("send_to_instance")!;
      const respond = vi.fn();

      await handler(ctx, { instance_name: "target", message: "hi" }, respond, meta);

      expect(cg.isLimited).toHaveBeenCalledWith("target");
      expect(target.messages).toHaveLength(1);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ sent: true, target: "target" }));
    });

    it("(c) ctx.costGuard is null → graceful dispatch, no error, no isLimited call", async () => {
      const { ctx, target } = makeCtx(null);
      const handler = outboundHandlers.get("send_to_instance")!;
      const respond = vi.fn();

      await handler(ctx, { instance_name: "target", message: "hi" }, respond, meta);

      expect(target.messages).toHaveLength(1);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ sent: true, target: "target" }));
    });

    it("report-kind messages bypass the cost-guard gate (terminal status)", async () => {
      // Reports must reach the orchestrator even when target is limited;
      // otherwise the merge gate stalls and impl can't escalate.
      const cg = mockCostGuard({ limited: true, limitUsd: 5 });
      const { ctx, target } = makeCtx(cg);
      const handler = outboundHandlers.get("send_to_instance")!;
      const respond = vi.fn();

      await handler(ctx, {
        instance_name: "target",
        message: "task done",
        request_kind: "report",
      }, respond, meta);

      expect(target.messages).toHaveLength(1);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ sent: true, target: "target" }));
    });
  });

  describe("delegate_task", () => {
    it("(a) target is limited → immediate warning result, no dispatch", async () => {
      const cg = mockCostGuard({ limited: true, limitUsd: 5 });
      const { ctx, target } = makeCtx(cg);
      const handler = outboundHandlers.get("delegate_task")!;
      const respond = vi.fn();

      await handler(ctx, { target_instance: "target", task: "do thing" }, respond, meta);

      expect(cg.isLimited).toHaveBeenCalledWith("target");
      expect(target.messages).toHaveLength(0);
      expect(respond).toHaveBeenCalledTimes(1);
      const [result, error] = respond.mock.calls[0];
      expect(result).toBeNull();
      expect(error).toContain("cost-guard");
      expect(error).toContain("'target'");
      expect(error).toContain("$5.00");
    });

    it("(b) target is not limited → normal dispatch", async () => {
      const cg = mockCostGuard({ limited: false, limitUsd: 5 });
      const { ctx, target } = makeCtx(cg);
      const handler = outboundHandlers.get("delegate_task")!;
      const respond = vi.fn();

      await handler(ctx, { target_instance: "target", task: "do thing" }, respond, meta);

      expect(cg.isLimited).toHaveBeenCalledWith("target");
      expect(target.messages).toHaveLength(1);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ sent: true, target: "target" }));
    });

    it("(c) ctx.costGuard is null → graceful dispatch, no error, no isLimited call", async () => {
      const { ctx, target } = makeCtx(null);
      const handler = outboundHandlers.get("delegate_task")!;
      const respond = vi.fn();

      await handler(ctx, { target_instance: "target", task: "do thing" }, respond, meta);

      expect(target.messages).toHaveLength(1);
      expect(respond).toHaveBeenCalledWith(expect.objectContaining({ sent: true, target: "target" }));
    });
  });
});

// ── #24 follow-up: broadcast handler gap ────────────────────────────────────
//
// `broadcast` runs its own per-target send loop without funnelling through
// sendToInstance, so PR #57's gate did not cover it. ts-reviewer flagged the
// gap on PR #57 (Out-of-scope Observation 1). This block verifies the gate
// in three states, scoped per ts-lead's follow-up dispatch:
//   (a) mixed — limited targets warn + skip, others receive
//   (b) all limited — every target warns, zero IPC sends
//   (c) all not limited — behaves identically to pre-fix
//
// BroadcastRequestKind already excludes "report", so no kind-bypass is needed.

interface MockTargetSet {
  ipcs: Record<string, MockIpcChannel>;
  ctx: any; // OutboundContext; uses vitest mocks so cast for brevity
}

function makeBroadcastCtx(targetNames: string[], costGuard: CostGuardMock | null): MockTargetSet {
  const ipcs: Record<string, MockIpcChannel> = {};
  const instanceIpcClients = new Map<string, { send: (msg: unknown) => void }>();
  // sender's own ipc — broadcast filters it out by name match
  const senderIpc = mockIpc();
  ipcs.sender = senderIpc;
  instanceIpcClients.set("sender", senderIpc.ipc);
  for (const name of targetNames) {
    const ch = mockIpc();
    ipcs[name] = ch;
    instanceIpcClients.set(name, ch.ipc);
  }
  return {
    ipcs,
    ctx: {
      fleetConfig: { instances: Object.fromEntries(["sender", ...targetNames].map(n => [n, { working_directory: `/tmp/${n}` }])) },
      adapter: null,
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      routing: { resolve: () => undefined },
      instanceIpcClients,
      lifecycle: { daemons: new Map() },
      sessionRegistry: new Map(),
      eventLog: null,
      costGuard,
      lastActivityMs: () => 0,
      startInstance: vi.fn(),
      connectIpcToInstance: vi.fn(),
      saveFleetConfig: vi.fn(),
    },
  };
}

describe("#24 follow-up — cost-guard pre-check at broadcast dispatch", () => {
  // Per-target isLimited mock: only the names in `limitedSet` are over budget.
  function partialCostGuard(limitedSet: Set<string>, limitUsd = 5): CostGuardMock {
    const limitCents = limitUsd * 100;
    return {
      isLimited: vi.fn((name: string) => limitedSet.has(name)),
      getLimitCents: vi.fn(() => limitCents),
      getDailyCostCents: vi.fn((name: string) => limitedSet.has(name) ? limitCents + 100 : 0),
    };
  }

  it("(a) mixed targets — limited skipped with warning, others delivered", async () => {
    const cg = partialCostGuard(new Set(["target-b"]));
    const { ctx, ipcs } = makeBroadcastCtx(["target-a", "target-b", "target-c"], cg);
    const handler = outboundHandlers.get("broadcast")!;
    const respond = vi.fn();

    await handler(ctx, { message: "hello fleet", targets: ["target-a", "target-b", "target-c"] }, respond, meta);

    expect(ipcs["target-a"].messages).toHaveLength(1);
    expect(ipcs["target-b"].messages).toHaveLength(0);
    expect(ipcs["target-c"].messages).toHaveLength(1);

    expect(respond).toHaveBeenCalledTimes(1);
    const result = respond.mock.calls[0][0] as {
      sent_to: string[];
      failed: string[];
      cost_limited: { target: string; warning: string }[];
      count: number;
    };
    expect(result.sent_to).toEqual(["target-a", "target-c"]);
    expect(result.cost_limited).toHaveLength(1);
    expect(result.cost_limited[0].target).toBe("target-b");
    expect(result.cost_limited[0].warning).toContain("cost-guard");
    expect(result.cost_limited[0].warning).toContain("'target-b'");
    expect(result.cost_limited[0].warning).toContain("$5.00");
    expect(result.failed).toEqual([]);
    expect(result.count).toBe(2);
  });

  it("(b) all targets limited — every target warns, zero IPC sends", async () => {
    const cg = partialCostGuard(new Set(["target-a", "target-b", "target-c"]));
    const { ctx, ipcs } = makeBroadcastCtx(["target-a", "target-b", "target-c"], cg);
    const handler = outboundHandlers.get("broadcast")!;
    const respond = vi.fn();

    await handler(ctx, { message: "hello fleet", targets: ["target-a", "target-b", "target-c"] }, respond, meta);

    expect(ipcs["target-a"].messages).toHaveLength(0);
    expect(ipcs["target-b"].messages).toHaveLength(0);
    expect(ipcs["target-c"].messages).toHaveLength(0);

    const result = respond.mock.calls[0][0] as {
      sent_to: string[];
      cost_limited: { target: string }[];
      count: number;
    };
    expect(result.sent_to).toEqual([]);
    expect(result.cost_limited.map(e => e.target).sort()).toEqual(["target-a", "target-b", "target-c"]);
    expect(result.count).toBe(0);
  });

  it("(c) no targets limited — behaves identically to pre-fix (cost_limited empty)", async () => {
    const cg = partialCostGuard(new Set());
    const { ctx, ipcs } = makeBroadcastCtx(["target-a", "target-b"], cg);
    const handler = outboundHandlers.get("broadcast")!;
    const respond = vi.fn();

    await handler(ctx, { message: "hello fleet", targets: ["target-a", "target-b"] }, respond, meta);

    expect(ipcs["target-a"].messages).toHaveLength(1);
    expect(ipcs["target-b"].messages).toHaveLength(1);

    const result = respond.mock.calls[0][0] as {
      sent_to: string[];
      cost_limited: unknown[];
      count: number;
    };
    expect(result.sent_to).toEqual(["target-a", "target-b"]);
    expect(result.cost_limited).toEqual([]);
    expect(result.count).toBe(2);
  });
});
