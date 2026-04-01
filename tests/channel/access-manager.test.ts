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

  it("generates 8-char hex pairing code", () => {
    const code = am.generateCode(999);
    expect(code).toMatch(/^[0-9A-F]{8}$/);
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

  // String/number cross-type matching (Bug: snowflake fix regression)
  it("isAllowed matches number userId against string allowlist", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: ["111", "222"], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-type.json"),
    );
    // Telegram sends number, YAML/wizard may store string
    expect(am2.isAllowed(111)).toBe(true);
    expect(am2.isAllowed("111")).toBe(true);
    expect(am2.isAllowed(999)).toBe(false);
  });

  it("isAllowed matches string userId against number allowlist", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111, 222], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-type2.json"),
    );
    // Discord sends string
    expect(am2.isAllowed("111")).toBe(true);
    expect(am2.isAllowed(111)).toBe(true);
  });

  it("removeUser works across types", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: ["111"], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-remove.json"),
    );
    expect(am2.removeUser(111)).toBe(true); // number removes string entry
    expect(am2.isAllowed("111")).toBe(false);
  });

  it("constructor deduplicates across types", () => {
    const am2 = new AccessManager(
      { mode: "pairing", allowed_users: [111, "111", 222], max_pending_codes: 3, code_expiry_minutes: 60 },
      join(tmpDir, "cross-dedup.json"),
    );
    expect(am2.getAllowedUsers()).toHaveLength(2); // 111 and 222, not 111, "111", 222
  });
});
