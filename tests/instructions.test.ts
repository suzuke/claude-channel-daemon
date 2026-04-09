import { describe, it, expect } from "vitest";
import { buildFleetInstructions } from "../src/instructions.js";

describe("buildFleetInstructions", () => {
  const base = { instanceName: "test-inst", workingDirectory: "/home/user/project" };

  it("includes instance name and working directory", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("**test-inst**");
    expect(result).toContain("`/home/user/project`");
  });

  it("includes message format and collaboration rules", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("[user:");
    expect(result).toContain("[from:");
    expect(result).toContain("`reply` tool");
    expect(result).toContain("send_to_instance");
  });

  it("includes display name when provided", () => {
    const result = buildFleetInstructions({ ...base, displayName: "Luna" });
    expect(result).toContain('"Luna"');
  });

  it("prompts for display name when not provided", () => {
    const result = buildFleetInstructions(base);
    expect(result).toContain("set_display_name");
  });

  it("includes description as role", () => {
    const result = buildFleetInstructions({ ...base, description: "Code reviewer" });
    expect(result).toContain("## Role");
    expect(result).toContain("Code reviewer");
  });

  it("includes custom prompt", () => {
    const result = buildFleetInstructions({ ...base, customPrompt: "Always use TypeScript" });
    expect(result).toContain("Always use TypeScript");
  });

  it("includes inline workflow content", () => {
    const result = buildFleetInstructions({ ...base, workflow: "Custom workflow rules" });
    expect(result).toContain("## Development Workflow");
    expect(result).toContain("Custom workflow rules");
  });

  it("excludes workflow when false", () => {
    const result = buildFleetInstructions({ ...base, workflow: false });
    expect(result).not.toContain("## Development Workflow");
  });

  it("includes decisions", () => {
    const result = buildFleetInstructions({
      ...base,
      decisions: [{ title: "Use ESM", content: "All modules should use ESM imports." }],
    });
    expect(result).toContain("## Active Decisions");
    expect(result).toContain("**Use ESM**");
  });

  it("caps decisions at 15 with overflow note", () => {
    const decisions = Array.from({ length: 20 }, (_, i) => ({
      title: `Decision ${i}`,
      content: `Content ${i}`,
    }));
    const result = buildFleetInstructions({ ...base, decisions });
    expect(result).toContain("5 more");
    expect(result).toContain("list_decisions");
  });

  it("omits decisions section when empty", () => {
    const result = buildFleetInstructions({ ...base, decisions: [] });
    expect(result).not.toContain("## Active Decisions");
  });
});
