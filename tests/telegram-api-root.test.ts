import { describe, it, expect, afterEach } from "vitest";
import { validateTelegramApiRoot } from "../src/channel/adapters/telegram.js";

describe("validateTelegramApiRoot (P3.3)", () => {
  const original = process.env.AGEND_TELEGRAM_API_ROOT_ALLOWLIST;
  afterEach(() => {
    if (original === undefined) delete process.env.AGEND_TELEGRAM_API_ROOT_ALLOWLIST;
    else process.env.AGEND_TELEGRAM_API_ROOT_ALLOWLIST = original;
  });

  it("accepts the official API root", () => {
    expect(() => validateTelegramApiRoot("https://api.telegram.org")).not.toThrow();
  });

  it("accepts localhost mock server on any port", () => {
    expect(() => validateTelegramApiRoot("http://localhost:8081")).not.toThrow();
    expect(() => validateTelegramApiRoot("http://127.0.0.1:9000")).not.toThrow();
  });

  it("rejects arbitrary third-party hosts by default", () => {
    expect(() => validateTelegramApiRoot("https://evil.example.com")).toThrow(/allowlist/);
  });

  it("rejects non-http(s) schemes", () => {
    expect(() => validateTelegramApiRoot("ftp://api.telegram.org")).toThrow(/http/);
  });

  it("rejects malformed URLs", () => {
    expect(() => validateTelegramApiRoot("not-a-url")).toThrow(/Invalid/);
  });

  it("honors AGEND_TELEGRAM_API_ROOT_ALLOWLIST override", () => {
    process.env.AGEND_TELEGRAM_API_ROOT_ALLOWLIST = "corp.internal,other.test";
    expect(() => validateTelegramApiRoot("https://corp.internal/bot")).not.toThrow();
    expect(() => validateTelegramApiRoot("https://other.test")).not.toThrow();
    expect(() => validateTelegramApiRoot("https://unlisted.com")).toThrow();
  });
});
