import { describe, it, expect, vi } from "vitest";
import { MeetingOrchestrator } from "../../src/meeting/orchestrator.js";
import { assignRoles } from "../../src/meeting/role-assigner.js";
import type { FleetManagerMeetingAPI, MeetingChannelOutput, MeetingConfig } from "../../src/meeting/types.js";

describe("Meeting integration", () => {
  it("runs a full 2-round debate with 3 participants", async () => {
    const posted: string[] = [];
    let instanceCounter = 0;
    let replyCounter = 0;

    const fm: FleetManagerMeetingAPI = {
      spawnEphemeralInstance: vi.fn().mockImplementation(async () => `inst-${instanceCounter++}`),
      destroyEphemeralInstance: vi.fn().mockResolvedValue(undefined),
      sendAndWaitReply: vi.fn().mockImplementation(async (_name: string, prompt: string) => {
        replyCounter++;
        if (prompt.includes("摘要")) return "## 會議摘要\n正方主張拆分，反方認為風險太高，仲裁建議先試點。";
        return `回覆 #${replyCounter}: 這是對議題的論述。`;
      }),
      createMeetingChannel: vi.fn().mockResolvedValue({ channelId: 1 }),
      closeMeetingChannel: vi.fn().mockResolvedValue(undefined),
    };

    const output: MeetingChannelOutput = {
      postMessage: vi.fn().mockImplementation(async (text: string) => {
        posted.push(text);
        return `msg-${posted.length}`;
      }),
      editMessage: vi.fn().mockResolvedValue(undefined),
    };

    const config: MeetingConfig = {
      meetingId: "int-test",
      topic: "是否採用 microservices",
      mode: "debate",
      maxRounds: 2,
    };

    const participants = assignRoles(3);
    expect(participants).toHaveLength(3);
    expect(participants.map(p => p.role)).toEqual(["pro", "con", "arbiter"]);

    const orch = new MeetingOrchestrator(config, fm, output);
    await orch.start(participants);

    // 3 instances spawned
    expect(fm.spawnEphemeralInstance).toHaveBeenCalledTimes(3);

    // sendAndWaitReply: 2 rounds × 3 speakers + 1 summary = 7
    expect(fm.sendAndWaitReply).toHaveBeenCalledTimes(7);

    // Check posted messages contain round headers
    expect(posted.some(p => p.includes("Round 1"))).toBe(true);
    expect(posted.some(p => p.includes("Round 2"))).toBe(true);

    // Check posted messages contain participant labels with emojis
    expect(posted.some(p => p.includes("🟢") && p.includes("A"))).toBe(true);
    expect(posted.some(p => p.includes("🔴") && p.includes("B"))).toBe(true);
    expect(posted.some(p => p.includes("⚖️") && p.includes("C"))).toBe(true);

    // Check summary was generated
    expect(posted.some(p => p.includes("會議摘要"))).toBe(true);
    expect(posted.some(p => p.includes("先試點"))).toBe(true);

    // Check meeting ended
    expect(posted[posted.length - 1]).toBe("📋 會議結束");

    // All 3 instances destroyed
    expect(fm.destroyEphemeralInstance).toHaveBeenCalledTimes(3);
  });

  it("runs a 2-person debate with custom names", async () => {
    const posted: string[] = [];
    let instanceCounter = 0;

    const fm: FleetManagerMeetingAPI = {
      spawnEphemeralInstance: vi.fn().mockImplementation(async () => `inst-${instanceCounter++}`),
      destroyEphemeralInstance: vi.fn().mockResolvedValue(undefined),
      sendAndWaitReply: vi.fn().mockResolvedValue("test reply"),
      createMeetingChannel: vi.fn().mockResolvedValue({ channelId: 1 }),
      closeMeetingChannel: vi.fn().mockResolvedValue(undefined),
    };

    const output: MeetingChannelOutput = {
      postMessage: vi.fn().mockImplementation(async (text: string) => {
        posted.push(text);
        return `msg-${posted.length}`;
      }),
      editMessage: vi.fn().mockResolvedValue(undefined),
    };

    const participants = assignRoles(2, ["Alice", "Bob"]);
    expect(participants[0].label).toBe("Alice");
    expect(participants[1].label).toBe("Bob");

    const config: MeetingConfig = {
      meetingId: "custom-names",
      topic: "test topic",
      mode: "debate",
      maxRounds: 1,
    };

    const orch = new MeetingOrchestrator(config, fm, output);
    await orch.start(participants);

    expect(posted.some(p => p.includes("Alice"))).toBe(true);
    expect(posted.some(p => p.includes("Bob"))).toBe(true);
    expect(fm.destroyEphemeralInstance).toHaveBeenCalledTimes(2);
  });
});
