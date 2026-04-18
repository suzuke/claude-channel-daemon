import { describe, it, expect } from "vitest";
import { extractWebToken, computeCorsOrigin, parseCorsOriginsEnv } from "../src/web-auth.js";

describe("extractWebToken (P3.5)", () => {
  it("prefers Authorization: Bearer over other transports", () => {
    const t = extractWebToken(
      { authorization: "Bearer abc", "x-agend-token": "xyz" },
      new URLSearchParams("token=query-val"),
    );
    expect(t).toBe("abc");
  });

  it("falls back to X-Agend-Token when no Authorization", () => {
    const t = extractWebToken({ "x-agend-token": "xyz" }, new URLSearchParams());
    expect(t).toBe("xyz");
  });

  it("falls back to ?token= query param when no headers", () => {
    const t = extractWebToken({}, new URLSearchParams("token=qqq"));
    expect(t).toBe("qqq");
  });

  it("returns null when no credential is supplied", () => {
    expect(extractWebToken({}, new URLSearchParams())).toBe(null);
  });

  it("is case-insensitive for the Bearer scheme", () => {
    const t = extractWebToken({ authorization: "bEaReR tok" }, new URLSearchParams());
    expect(t).toBe("tok");
  });

  it("ignores non-Bearer Authorization headers", () => {
    const t = extractWebToken({ authorization: "Basic abc" }, new URLSearchParams("token=q"));
    expect(t).toBe("q");
  });
});

describe("computeCorsOrigin (P3.5)", () => {
  it("returns null when allowlist is empty", () => {
    expect(computeCorsOrigin("http://a.com", [])).toBe(null);
  });

  it("returns null when request origin is not in allowlist", () => {
    expect(computeCorsOrigin("http://evil.com", ["http://ok.com"])).toBe(null);
  });

  it("echoes the request origin when in allowlist", () => {
    expect(computeCorsOrigin("http://ok.com", ["http://ok.com"])).toBe("http://ok.com");
  });

  it("returns * when allowlist contains *", () => {
    expect(computeCorsOrigin("http://anything.com", ["*"])).toBe("*");
  });

  it("returns null when request has no Origin header", () => {
    expect(computeCorsOrigin(null, ["http://ok.com"])).toBe(null);
  });
});

describe("parseCorsOriginsEnv (P3.5)", () => {
  it("returns empty array when env var is unset", () => {
    expect(parseCorsOriginsEnv(undefined)).toEqual([]);
  });

  it("splits comma-separated values and trims whitespace", () => {
    expect(parseCorsOriginsEnv(" a , b,c ")).toEqual(["a", "b", "c"]);
  });

  it("drops empty entries", () => {
    expect(parseCorsOriginsEnv("a,,b,")).toEqual(["a", "b"]);
  });
});
