import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AccessManager } from "../../src/channel/access-manager.js";
import { join } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("AccessManager", () => {
  let tmpDir: string;
  let am: AccessManager;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `ccd-access-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    am = new AccessManager(
      { mode: "pairing", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "access.json"),
    );
  });

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it("allows known users", () => { expect(am.isAllowed(111)).toBe(true); });
  it("rejects unknown users", () => { expect(am.isAllowed(999)).toBe(false); });

  it("rejects unknown users in locked mode", () => {
    am.setMode("locked");
    expect(am.isAllowed(999)).toBe(false);
  });

  it("generates 6-char hex pairing code", () => {
    const code = am.generateCode(999);
    expect(code).toMatch(/^[0-9A-F]{6}$/);
  });

  it("confirms valid pairing code and adds to allowlist", () => {
    const code = am.generateCode(999);
    expect(am.confirmCode(code)).toBe(true);
    expect(am.isAllowed(999)).toBe(true);
  });

  it("rejects invalid pairing code", () => {
    expect(am.confirmCode("ZZZZZZ")).toBe(false);
  });

  it("limits pairing attempts per user to 2", () => {
    am.generateCode(999);
    am.generateCode(999);
    expect(am.hasPairingQuota(999)).toBe(false);
    expect(() => am.generateCode(999)).toThrow();
  });

  it("limits total pending codes to max_pending_codes unique users", () => {
    am.generateCode(100);
    am.generateCode(200);
    am.generateCode(300);
    expect(() => am.generateCode(400)).toThrow(/max pending/i);
  });

  it("persists mode across instances", () => {
    am.setMode("locked");
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "access.json"),
    );
    expect(am2.getMode()).toBe("locked");
  });

  it("persists allowlist across instances", () => {
    const code = am.generateCode(999);
    am.confirmCode(code);
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "access.json"),
    );
    expect(am2.isAllowed(999)).toBe(true);
  });

  it("removes user from allowlist", () => {
    expect(am.removeUser(111)).toBe(true);
    expect(am.isAllowed(111)).toBe(false);
  });
});
