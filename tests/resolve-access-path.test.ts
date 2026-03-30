import { describe, it, expect } from "vitest";
import { resolveAccessPathFromConfig } from "../src/access-path.js";
import { join } from "node:path";

describe("resolveAccessPathFromConfig", () => {
  const dataDir = "/data";

  it("returns fleet-level path for topic mode", () => {
    const result = resolveAccessPathFromConfig(dataDir, "my-inst", { mode: "topic" });
    expect(result).toBe(join(dataDir, "access", "access.json"));
  });

  it("returns fleet-level path when no fleet channel configured", () => {
    const result = resolveAccessPathFromConfig(dataDir, "my-inst", undefined);
    expect(result).toBe(join(dataDir, "access", "access.json"));
  });
});
