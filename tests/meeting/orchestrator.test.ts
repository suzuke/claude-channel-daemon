import { describe, it, expect, vi, beforeEach } from "vitest";
import { MeetingOrchestrator } from "../../src/meeting/orchestrator.js";
import type { FleetManagerMeetingAPI, MeetingChannelOutput, MeetingConfig, ParticipantConfig } from "../../src/meeting/types.js";
import type { InboundMessage } from "../../src/channel/types.js";

function mockFm(): FleetManagerMeetingAPI {
  let instanceCounter = 0;
  return {
    spawnEphemeralInstance: vi.fn().mockImplementation(async () => `inst-${instanceCounter++}`),
    destroyEphemeralInstance: vi.fn().mockResolvedValue(undefined),
    sendAndWaitReply: vi.fn().mockResolvedValue("Mock reply"),
    createMeetingChannel: vi.fn().mockResolvedValue({ channelId: 999 }),
    closeMeetingChannel: vi.fn().mockResolvedValue(undefined),
  };
}

function mockOutput(): MeetingChannelOutput {
  return {
    postMessage: vi.fn().mockResolvedValue("msg-1"),
    editMessage: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMsg(text: string): InboundMessage {
  return {
    source: "test", adapterId: "test", chatId: "c", messageId: "m",
    userId: "u", username: "user", text, timestamp: new Date(),
  };
}

const defaultConfig: MeetingConfig = {
  meetingId: "test-001", topic: "要不要拆 monorepo？", mode: "debate", maxRounds: 2,
};

const defaultParticipants: ParticipantConfig[] = [
  { label: "A", role: "pro" },
  { label: "B", role: "con" },
];

describe("MeetingOrchestrator", () => {
  let fm: ReturnType<typeof mockFm>;
  let output: ReturnType<typeof mockOutput>;

  beforeEach(() => { fm = mockFm(); output = mockOutput(); });

  it("spawns instances on start", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    expect(fm.spawnEphemeralInstance).toHaveBeenCalledTimes(2);
  });

  it("runs debate rounds and posts results", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    // 2 rounds × 2 speakers = 4, plus 1 summary = 5 sendAndWaitReply calls
    expect(fm.sendAndWaitReply).toHaveBeenCalledTimes(5);
    expect(output.postMessage).toHaveBeenCalled();
  });

  it("destroys instances on end", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    expect(fm.destroyEphemeralInstance).toHaveBeenCalledTimes(2);
  });

  it("handles partial spawn failures", async () => {
    fm.spawnEphemeralInstance = vi.fn()
      .mockResolvedValueOnce("inst-0")
      .mockRejectedValueOnce(new Error("spawn failed"));
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    // Should still complete with 1 participant
    expect(fm.sendAndWaitReply).toHaveBeenCalled();
  });

  it("ends meeting when all spawns fail", async () => {
    fm.spawnEphemeralInstance = vi.fn().mockRejectedValue(new Error("fail"));
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    expect(orch.getState()).toBe("ended");
    const messages = (output.postMessage as any).mock.calls.map((c: any) => c[0]);
    expect(messages.some((m: string) => m.includes("所有 instance 啟動失敗"))).toBe(true);
  });

  it("handles timeout by skipping turn", async () => {
    fm.sendAndWaitReply = vi.fn()
      .mockResolvedValueOnce("A's argument")
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue("More replies");
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    const messages = (output.postMessage as any).mock.calls.map((c: any) => c[0]);
    expect(messages.some((m: string) => m.includes("逾時"))).toBe(true);
  });

  it("handles /more to extend rounds", async () => {
    const shortConfig = { ...defaultConfig, maxRounds: 1 };
    let callCount = 0;
    fm.sendAndWaitReply = vi.fn().mockImplementation(async () => {
      callCount++;
      return "reply";
    });
    const orch = new MeetingOrchestrator(shortConfig, fm, output);
    // Extend before starting
    orch.handleUserMessage(makeMsg("/more 2"));
    await orch.start(defaultParticipants);
    // Should have run 3 rounds (1+2) × 2 speakers + 1 summary = 7
    expect(callCount).toBe(7);
  });

  it("posts meeting end message", async () => {
    const orch = new MeetingOrchestrator(defaultConfig, fm, output);
    await orch.start(defaultParticipants);
    const messages = (output.postMessage as any).mock.calls.map((c: any) => c[0]);
    expect(messages[messages.length - 1]).toBe("📋 會議結束");
  });
});
