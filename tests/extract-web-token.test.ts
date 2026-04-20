import { describe, it, expect } from "vitest";
import { extractWebToken } from "../src/fleet-health-server.js";

function url(qs = ""): URL {
  return new URL(`http://localhost:8080/api/fleet${qs}`);
}

describe("extractWebToken", () => {
  it("returns null when no token is provided", () => {
    expect(extractWebToken(url(), {})).toBeNull();
  });

  it("reads ?token= query parameter", () => {
    expect(extractWebToken(url("?token=abc123"), {})).toBe("abc123");
  });

  it("reads Authorization: Bearer header", () => {
    expect(extractWebToken(url(), { authorization: "Bearer abc123" })).toBe("abc123");
  });

  it("Bearer header is case-insensitive", () => {
    expect(extractWebToken(url(), { authorization: "bearer abc123" })).toBe("abc123");
    expect(extractWebToken(url(), { authorization: "BEARER abc123" })).toBe("abc123");
  });

  it("ignores Authorization without Bearer prefix", () => {
    expect(extractWebToken(url(), { authorization: "Basic abc123" })).toBeNull();
  });

  it("falls back to legacy X-Agend-Token header", () => {
    expect(extractWebToken(url(), { "x-agend-token": "legacy-token" })).toBe("legacy-token");
  });

  it("query string wins over headers (single source of truth for browsers)", () => {
    expect(extractWebToken(url("?token=q"), {
      authorization: "Bearer b",
      "x-agend-token": "x",
    })).toBe("q");
  });

  it("Bearer wins over legacy X-Agend-Token", () => {
    expect(extractWebToken(url(), {
      authorization: "Bearer b",
      "x-agend-token": "x",
    })).toBe("b");
  });

  it("handles array-valued headers (Node may give string[])", () => {
    expect(extractWebToken(url(), { authorization: ["Bearer arr"] })).toBe("arr");
    expect(extractWebToken(url(), { "x-agend-token": ["arr"] })).toBe("arr");
  });

  it("trims whitespace inside Bearer value", () => {
    expect(extractWebToken(url(), { authorization: "Bearer   spaced  " })).toBe("spaced");
  });
});
