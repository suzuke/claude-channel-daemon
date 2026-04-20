import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Daemon } from "../src/daemon.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import type { InstanceConfig } from "../src/types.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const makeConfig = (): InstanceConfig => ({
  working_directory: "/tmp/test",
  restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
  context_guardian: { restart_threshold_pct: 80, max_age_hours: 4, grace_period_ms: 600_000 },
  memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
  log_level: "info",
});

class TestableDaemon extends Daemon {
  /** Replace the ipcServer with a stub that records broadcasts. */
  installFakeIpc(): { broadcasts: unknown[] } {
    const broadcasts: unknown[] = [];
    this.ipcServer = {
      broadcast: (m: unknown) => { broadcasts.push(m); },
      // The unused members are not exercised by dispatchFleetRpc itself.
    } as unknown as NonNullable<typeof this.ipcServer>;
    return { broadcasts };
  }

  callDispatch(
    fleetReqId: string,
    broadcast: Record<string, unknown>,
    timeoutMs: number,
    timeoutMessage: string,
    respond: (result: unknown, error?: string) => void,
  ): void {
    return this.dispatchFleetRpc(fleetReqId, broadcast, timeoutMs, timeoutMessage, respond);
  }

  hasPending(fleetReqId: string): boolean {
    return this.pendingIpcRequests.has(fleetReqId);
  }

  triggerPending(fleetReqId: string, msg: Record<string, unknown>): void {
    this.pendingIpcRequests.get(fleetReqId)!(msg);
    this.pendingIpcRequests.delete(fleetReqId);
  }
}

describe("Daemon.dispatchFleetRpc (P4.2 review #1)", () => {
  let tmpDir: string;
  let daemon: TestableDaemon;

  beforeEach(() => {
    vi.useFakeTimers();
    tmpDir = join(tmpdir(), `ccd-dispatch-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const backend = new ClaudeCodeBackend(tmpDir);
    daemon = new TestableDaemon("test", makeConfig(), tmpDir, false, backend);
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("broadcasts the envelope and registers a pending callback", () => {
    const { broadcasts } = daemon.installFakeIpc();
    const respond = vi.fn();
    const envelope = { type: "fleet_task", payload: { x: 1 }, fleetRequestId: "task_1" };

    daemon.callDispatch("task_1", envelope, 30_000, "Task timed out", respond);

    expect(broadcasts).toEqual([envelope]);
    expect(daemon.hasPending("task_1")).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });

  it("forwards the fleet response to respond and clears the pending entry", () => {
    daemon.installFakeIpc();
    const respond = vi.fn();
    daemon.callDispatch("dec_2", { type: "fleet_decision_create", fleetRequestId: "dec_2" },
      30_000, "Decision timed out", respond);

    daemon.triggerPending("dec_2", { result: { id: "abc" }, error: undefined });
    expect(respond).toHaveBeenCalledWith({ id: "abc" }, undefined);

    // Subsequent timer fires must be a no-op (timeout was cleared by the callback).
    vi.advanceTimersByTime(60_000);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("propagates the fleet response error string", () => {
    daemon.installFakeIpc();
    const respond = vi.fn();
    daemon.callDispatch("xmsg_3", { type: "fleet_outbound", fleetRequestId: "xmsg_3" },
      30_000, "Cross-instance timed out", respond);

    daemon.triggerPending("xmsg_3", { result: null, error: "remote-failure" });
    expect(respond).toHaveBeenCalledWith(null, "remote-failure");
  });

  it("fires the timeout error and removes the pending entry when no response arrives", () => {
    daemon.installFakeIpc();
    const respond = vi.fn();
    daemon.callDispatch("sched_4", { type: "fleet_schedule_create", fleetRequestId: "sched_4" },
      30_000, "Schedule operation timed out after 30s", respond);

    expect(daemon.hasPending("sched_4")).toBe(true);
    vi.advanceTimersByTime(30_000);

    expect(respond).toHaveBeenCalledWith(null, "Schedule operation timed out after 30s");
    expect(daemon.hasPending("sched_4")).toBe(false);
  });

  it("does not respond before the timeout fires", () => {
    daemon.installFakeIpc();
    const respond = vi.fn();
    daemon.callDispatch("dn_5", { type: "fleet_set_display_name", fleetRequestId: "dn_5" },
      10_000, "set_display_name timed out", respond);

    vi.advanceTimersByTime(9_999);
    expect(respond).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(respond).toHaveBeenCalledWith(null, "set_display_name timed out");
  });
});
