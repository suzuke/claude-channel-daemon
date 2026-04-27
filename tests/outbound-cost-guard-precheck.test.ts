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
