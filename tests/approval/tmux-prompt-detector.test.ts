import { describe, it, expect } from "vitest";
import { detectPermissionPrompt, extractToolPattern } from "../../src/approval/tmux-prompt-detector.js";

describe("detectPermissionPrompt", () => {
  it("detects old format (no space)", () => {
    expect(detectPermissionPrompt("Edit .claude/settings.json?\n1.Yes  2.Yes,andallow  3.No")).toBe(true);
  });

  it("detects new format (with space)", () => {
    expect(detectPermissionPrompt(
      "Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again\n  3. No"
    )).toBe(true);
  });

  it("detects prompt with ANSI codes", () => {
    const ansi = "\x1b[32m1\x1b[0m. Yes\n\x1b[31m3\x1b[0m. No";
    expect(detectPermissionPrompt(ansi)).toBe(true);
  });

  it("ignores normal output", () => {
    expect(detectPermissionPrompt("Hello world")).toBe(false);
  });

  it("requires both markers", () => {
    expect(detectPermissionPrompt("1. Yes but no deny option")).toBe(false);
  });
});

describe("extractToolPattern", () => {
  it("extracts MCP tool pattern from prompt", () => {
    const text = `Tool use

puppeteer - puppeteer_navigate(url: "https://example.com")  (MCP)

Do you want to proceed?
❯ 1. Yes
  2. Yes, and don't ask again for puppeteer - puppeteer_navigate commands in
     /Users/foo/project
  3. No`;
    expect(extractToolPattern(text)).toBe("mcp__puppeteer__puppeteer_navigate(*)");
  });

  it("extracts built-in tool pattern", () => {
    const text = `2. Yes, and don't ask again for Bash commands in /foo`;
    expect(extractToolPattern(text)).toBe("Bash(*)");
  });

  it("returns null when no match", () => {
    expect(extractToolPattern("random text")).toBeNull();
  });

  it("handles ANSI codes in tool name", () => {
    const text = `2. Yes, and don\x1b[0m't ask again for \x1b[32mpuppeteer\x1b[0m - \x1b[32mpuppeteer_click\x1b[0m commands in /foo`;
    expect(extractToolPattern(text)).toBe("mcp__puppeteer__puppeteer_click(*)");
  });

  it("handles real tmux output with cursor-forward codes", () => {
    // Real data from ccplugin output.log — \x1b[1C = cursor forward (space)
    const text = "\x1b[3C\x1b[38;5;246m2.\x1b[1C\x1b[39mYes,\x1b[1Cand\x1b[1Cdont\x1b[1Cask\x1b[1Cagain\x1b[1Cfor\x1b[1C\x1b[1mpuppeteer\x1b[1C-\x1b[1Cpuppeteer_navigate\x1b[1C\x1b[22mcommands\x1b[1Cin";
    expect(extractToolPattern(text)).toBe("mcp__puppeteer__puppeteer_navigate(*)");
  });
});
