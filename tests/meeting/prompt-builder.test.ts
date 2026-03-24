import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildRoundPrompt, buildSummaryPrompt, roleLabel } from "../../src/meeting/prompt-builder.js";
import type { RoundEntry } from "../../src/meeting/types.js";

describe("roleLabel", () => {
  it("maps pro to 正方", () => expect(roleLabel("pro")).toBe("正方"));
  it("maps con to 反方", () => expect(roleLabel("con")).toBe("反方"));
  it("maps arbiter to 仲裁", () => expect(roleLabel("arbiter")).toBe("仲裁"));
  it("returns custom role as-is", () => expect(roleLabel("analyst")).toBe("analyst"));
});

describe("buildSystemPrompt", () => {
  it("generates pro system prompt with topic", () => {
    const prompt = buildSystemPrompt("pro", "要不要拆 monorepo？");
    expect(prompt).toContain("正方");
    expect(prompt).toContain("要不要拆 monorepo？");
    expect(prompt).toContain("支持");
    expect(prompt).toContain("reply");
  });

  it("generates con system prompt", () => {
    const prompt = buildSystemPrompt("con", "topic");
    expect(prompt).toContain("反方");
    expect(prompt).toContain("反");
  });

  it("generates arbiter system prompt", () => {
    const prompt = buildSystemPrompt("arbiter", "topic");
    expect(prompt).toContain("仲裁");
    expect(prompt).toContain("客觀");
  });
});

describe("buildRoundPrompt", () => {
  it("builds first round prompt", () => {
    const prompt = buildRoundPrompt("要不要拆？", 1, []);
    expect(prompt).toContain("Round 1");
    expect(prompt).toContain("要不要拆？");
    expect(prompt).toContain("第一輪");
  });

  it("includes previous round content", () => {
    const history: RoundEntry[] = [
      { round: 1, speaker: "A", role: "pro", content: "Pro argument" },
      { round: 1, speaker: "B", role: "con", content: "Con argument" },
    ];
    const prompt = buildRoundPrompt("topic", 2, history);
    expect(prompt).toContain("Pro argument");
    expect(prompt).toContain("Con argument");
  });

  it("includes user context", () => {
    const prompt = buildRoundPrompt("topic", 1, [], "考慮成本面");
    expect(prompt).toContain("考慮成本面");
  });
});

describe("buildSummaryPrompt", () => {
  it("includes all rounds", () => {
    const history: RoundEntry[] = [
      { round: 1, speaker: "A", role: "pro", content: "arg1" },
      { round: 1, speaker: "B", role: "con", content: "arg2" },
    ];
    const prompt = buildSummaryPrompt("要不要拆？", history);
    expect(prompt).toContain("arg1");
    expect(prompt).toContain("arg2");
    expect(prompt).toContain("摘要");
    expect(prompt).toContain("reply");
  });
});
