import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildRoundPrompt, buildSummaryPrompt, buildCollabSystemPrompt, buildCollabSummaryPrompt, buildDiscussionSystemPrompt, buildIndependentAnalysisPrompt, buildCrossDiscussionPrompt, buildConsensusPrompt, buildAngleGenerationPrompt, roleLabel } from "../../src/meeting/prompt-builder.js";
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

describe("buildCollabSystemPrompt", () => {
  it("includes participant label and topic", () => {
    const prompt = buildCollabSystemPrompt("A", "Implement OAuth");
    expect(prompt).toContain("A");
    expect(prompt).toContain("Implement OAuth");
    expect(prompt).toContain("reply");
  });
});

describe("buildCollabSummaryPrompt", () => {
  it("includes all entries", () => {
    const history: RoundEntry[] = [
      { round: 0, speaker: "A", role: "developer", content: "I'll do the frontend" },
    ];
    const prompt = buildCollabSummaryPrompt("task", history);
    expect(prompt).toContain("frontend");
    expect(prompt).toContain("摘要");
  });
});

describe("buildAngleGenerationPrompt", () => {
  it("includes topic and count", () => {
    const prompt = buildAngleGenerationPrompt("AI 導入", 3);
    expect(prompt).toContain("AI 導入");
    expect(prompt).toContain("3");
  });
});

describe("buildDiscussionSystemPrompt", () => {
  it("includes label, angle, and topic", () => {
    const prompt = buildDiscussionSystemPrompt("A", "技術面", "要不要導入 AI?");
    expect(prompt).toContain("A");
    expect(prompt).toContain("技術面");
    expect(prompt).toContain("要不要導入 AI?");
    expect(prompt).toContain("reply");
  });
});

describe("buildIndependentAnalysisPrompt", () => {
  it("includes angle and topic", () => {
    const prompt = buildIndependentAnalysisPrompt("要不要導入 AI?", "成本效益");
    expect(prompt).toContain("成本效益");
    expect(prompt).toContain("要不要導入 AI?");
    expect(prompt).toContain("獨立分析");
  });
});

describe("buildCrossDiscussionPrompt", () => {
  it("includes all analyses and own angle", () => {
    const analyses: RoundEntry[] = [
      { round: 0, speaker: "A", role: "技術面", content: "技術分析" },
      { round: 0, speaker: "B", role: "成本面", content: "成本分析" },
    ];
    const prompt = buildCrossDiscussionPrompt("topic", "技術面", analyses);
    expect(prompt).toContain("技術面");
    expect(prompt).toContain("技術分析");
    expect(prompt).toContain("成本分析");
    expect(prompt).toContain("reply");
  });
});

describe("buildConsensusPrompt", () => {
  it("includes all rounds and asks for consensus", () => {
    const history: RoundEntry[] = [
      { round: 0, speaker: "A", role: "技術面", content: "分析1" },
      { round: 0, speaker: "B", role: "成本面", content: "分析2" },
      { round: 1, speaker: "A", role: "技術面", content: "回應1" },
      { round: 1, speaker: "B", role: "成本面", content: "回應2" },
    ];
    const prompt = buildConsensusPrompt("topic", history);
    expect(prompt).toContain("獨立分析");
    expect(prompt).toContain("交叉討論 Round 1");
    expect(prompt).toContain("共識");
    expect(prompt).toContain("reply");
  });
});
