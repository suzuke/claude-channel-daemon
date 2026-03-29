import { describe, it, expect } from "vitest";
import { resolveAccessPathFromConfig } from "../src/access-path.js";
import { join } from "node:path";

describe("resolveAccessPathFromConfig", () => {
  const dataDir = "/data";

  it("returns fleet-level path for shared topic adapter", () => {
    const result = resolveAccessPathFromConfig(dataDir, "my-inst", { mode: "topic" }, undefined);
    expect(result).toBe(join(dataDir, "access", "access.json"));
  });

  it("returns per-instance path for DM mode", () => {
    const result = resolveAccessPathFromConfig(dataDir, "my-inst", { mode: "dm" }, undefined);
    expect(result).toBe(join(dataDir, "instances", "my-inst", "access", "access.json"));
  });

  it("returns per-instance path when instance has its own channel", () => {
    const result = resolveAccessPathFromConfig(dataDir, "my-inst", { mode: "topic" }, { mode: "dm" });
    expect(result).toBe(join(dataDir, "instances", "my-inst", "access", "access.json"));
  });

  it("returns per-instance path when no fleet channel configured", () => {
    const result = resolveAccessPathFromConfig(dataDir, "my-inst", undefined, undefined);
    expect(result).toBe(join(dataDir, "instances", "my-inst", "access", "access.json"));
  });
});
