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

  describe("collab mode", () => {
    const collabConfig: MeetingConfig = {
      meetingId: "collab-test", topic: "Implement OAuth", mode: "collab", maxRounds: 3, repo: "/tmp",
    };
    const collabParticipants: ParticipantConfig[] = [
      { label: "A", role: "developer" },
      { label: "B", role: "developer" },
    ];

    it("runs collab flow with discussion and development phases", async () => {
      const orch = new MeetingOrchestrator(collabConfig, fm, output);
      await orch.start(collabParticipants);

      const messages = (output.postMessage as any).mock.calls.map((c: any) => c[0]);
      expect(messages.some((p: string) => p.includes("討論分工"))).toBe(true);
      expect(messages.some((p: string) => p.includes("開始開發"))).toBe(true);
      expect(fm.destroyEphemeralInstance).toHaveBeenCalledTimes(2);
    });

    it("sends discussion prompts then development prompts", async () => {
      const orch = new MeetingOrchestrator(collabConfig, fm, output);
      await orch.start(collabParticipants);

      // 2 discussion + 2 development + 1 summary = 5 calls
      expect(fm.sendAndWaitReply).toHaveBeenCalledTimes(5);
    });

    it("handles development timeout gracefully", async () => {
      fm.sendAndWaitReply = vi.fn()
        .mockResolvedValueOnce("Plan A") // discussion A
        .mockResolvedValueOnce("Plan B") // discussion B
        .mockRejectedValueOnce(new Error("timeout")) // dev A fails
        .mockResolvedValueOnce("Done B") // dev B succeeds
        .mockResolvedValue("Summary"); // summary

      const orch = new MeetingOrchestrator(collabConfig, fm, output);
      await orch.start(collabParticipants);

      const messages = (output.postMessage as any).mock.calls.map((c: any) => c[0]);
      expect(messages.some((m: string) => m.includes("開發逾時或失敗"))).toBe(true);
    });
  });

  describe("discussion mode", () => {
    const discussionConfig: MeetingConfig = {
      meetingId: "disc-test", topic: "要不要導入 AI?", mode: "discussion",
      maxRounds: 1, angles: ["技術面", "成本面"],
    };
    const participants: ParticipantConfig[] = [
      { label: "A", role: "技術面" },
      { label: "B", role: "成本面" },
    ];

    it("runs independent analysis then cross discussion then consensus", async () => {
      const posted: string[] = [];
      output.postMessage = vi.fn().mockImplementation(async (text: string) => { posted.push(text); return "m"; });
      const orch = new MeetingOrchestrator(discussionConfig, fm, output);
      await orch.start(participants);
      expect(posted.some(p => p.includes("獨立分析"))).toBe(true);
      expect(posted.some(p => p.includes("交叉討論"))).toBe(true);
      expect(posted.some(p => p.includes("收斂結論"))).toBe(true);
      expect(fm.destroyEphemeralInstance).toHaveBeenCalledTimes(2);
    });

    it("sends correct number of prompts", async () => {
      const orch = new MeetingOrchestrator(discussionConfig, fm, output);
      await orch.start(participants);
      // 2 independent analysis + 2 cross discussion (1 round) + 1 consensus = 5
      expect(fm.sendAndWaitReply).toHaveBeenCalledTimes(5);
    });

    it("shows angles in header", async () => {
      const posted: string[] = [];
      output.postMessage = vi.fn().mockImplementation(async (text: string) => { posted.push(text); return "m"; });
      const orch = new MeetingOrchestrator(discussionConfig, fm, output);
      await orch.start(participants);
      expect(posted.some(p => p.includes("技術面") && p.includes("成本面") && p.includes("討論"))).toBe(true);
    });

    it("handles analysis timeout gracefully", async () => {
      fm.sendAndWaitReply = vi.fn()
        .mockResolvedValueOnce("Analysis A")
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValue("Reply");
      const posted: string[] = [];
      output.postMessage = vi.fn().mockImplementation(async (text: string) => { posted.push(text); return "m"; });
      const orch = new MeetingOrchestrator(discussionConfig, fm, output);
      await orch.start(participants);
      expect(posted.some(p => p.includes("分析逾時"))).toBe(true);
    });
  });
});
