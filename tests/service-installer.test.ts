import { describe, it, expect } from "vitest";
import { renderLaunchdPlist, renderSystemdUnit, detectPlatform, uninstallService } from "../src/service-installer.js";

describe("ServiceInstaller", () => {
  const vars = {
    label: "com.claude-channel-daemon",
    execPath: "/usr/local/bin/claude-channel-daemon",
    path: "/usr/local/bin:/usr/bin:/bin",
    workingDirectory: "/Users/test/project",
    logPath: "/Users/test/.claude-channel-daemon/daemon.log",
  };

  it("detects platform correctly", () => {
    const platform = detectPlatform();
    expect(["macos", "linux"]).toContain(platform);
  });

  it("renders launchd plist with correct values", () => {
    const plist = renderLaunchdPlist(vars);
    expect(plist).toContain("<string>com.claude-channel-daemon</string>");
    expect(plist).toContain("<string>/usr/local/bin/claude-channel-daemon</string>");
    expect(plist).toContain("<string>fleet</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<string>/usr/local/bin:/usr/bin:/bin</string>");
  });

  it("renders systemd unit with correct values", () => {
    const unit = renderSystemdUnit(vars);
    expect(unit).toContain("ExecStart=/usr/local/bin/claude-channel-daemon fleet start");
    expect(unit).toContain("WorkingDirectory=/Users/test/project");
    expect(unit).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin");
  });

  it("falls back to process.env.PATH when path is omitted", () => {
    const { path: _, ...varsWithoutPath } = vars;
    const plist = renderLaunchdPlist(varsWithoutPath);
    expect(plist).toContain("<key>PATH</key>");
    expect(plist).toContain(process.env.PATH!);
  });

  it("rejects logPath with newline (systemd directive injection)", () => {
    expect(() => renderSystemdUnit({
      ...vars,
      logPath: "/tmp/log\nExecStartPost=/bin/rm -rf /",
    })).toThrow(/control characters/);
  });

  it("rejects workingDirectory with NUL", () => {
    expect(() => renderLaunchdPlist({
      ...vars,
      workingDirectory: "/tmp/\x00escape",
    })).toThrow(/control characters/);
  });

  it("rejects non-absolute execPath", () => {
    expect(() => renderSystemdUnit({
      ...vars,
      execPath: "agend",
    })).toThrow(/absolute path/);
  });

  it("rejects label containing special chars", () => {
    expect(() => renderLaunchdPlist({
      ...vars,
      label: "com.agend; /bin/sh",
    })).toThrow(/label must match/);
  });
});
