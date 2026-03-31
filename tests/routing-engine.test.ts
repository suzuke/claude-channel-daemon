import { describe, it, expect } from "vitest";
import { RoutingEngine } from "../src/routing-engine.js";
import type { FleetConfig } from "../src/types.js";

function makeConfig(instances: Record<string, { topic_id?: number | string; general_topic?: boolean }>): FleetConfig {
  const full: Record<string, any> = {};
  for (const [name, opts] of Object.entries(instances)) {
    full[name] = {
      working_directory: `/tmp/${name}`,
      restart_policy: { max_retries: 3, backoff: "exponential", reset_after: 300 },
      context_guardian: { grace_period_ms: 600000, max_age_hours: 8 },
      log_level: "info",
      ...opts,
    };
  }
  return { defaults: {}, instances: full } as FleetConfig;
}

describe("RoutingEngine", () => {
  it("builds routing table from fleet config", () => {
    const engine = new RoutingEngine();
    engine.rebuild(makeConfig({
      "proj-a": { topic_id: 42 },
      "proj-b": { topic_id: 87 },
      "proj-c": {},
    }));
    expect(engine.resolve("42")).toEqual({ kind: "instance", name: "proj-a" });
    expect(engine.resolve("87")).toEqual({ kind: "instance", name: "proj-b" });
    expect(engine.resolve("999")).toBeUndefined();
    expect(engine.size).toBe(2);
  });

  it("normalizes numeric topic IDs to strings", () => {
    const engine = new RoutingEngine();
    engine.register(12345, { kind: "instance", name: "test" });
    expect(engine.resolve("12345")).toEqual({ kind: "instance", name: "test" });
  });

  it("handles snowflake-sized string IDs without precision loss", () => {
    const snowflake = "1234567890123456789";
    const engine = new RoutingEngine();
    engine.register(snowflake, { kind: "instance", name: "discord-inst" });
    expect(engine.resolve(snowflake)).toEqual({ kind: "instance", name: "discord-inst" });
  });

  it("marks general_topic as kind=general", () => {
    const engine = new RoutingEngine();
    engine.rebuild(makeConfig({
      general: { topic_id: 1, general_topic: true },
    }));
    expect(engine.resolve("1")).toEqual({ kind: "general", name: "general" });
  });

  it("unregister removes a route", () => {
    const engine = new RoutingEngine();
    engine.register(42, { kind: "instance", name: "proj" });
    expect(engine.resolve("42")).toBeDefined();
    engine.unregister(42);
    expect(engine.resolve("42")).toBeUndefined();
  });

  it("rebuild clears old routes", () => {
    const engine = new RoutingEngine();
    engine.register(99, { kind: "instance", name: "old" });
    engine.rebuild(makeConfig({ "new": { topic_id: 1 } }));
    expect(engine.resolve("99")).toBeUndefined();
    expect(engine.resolve("1")).toEqual({ kind: "instance", name: "new" });
  });

  it("returns summary string from rebuild", () => {
    const engine = new RoutingEngine();
    const summary = engine.rebuild(makeConfig({
      "proj-a": { topic_id: 42 },
    }));
    expect(summary).toBe("#42→proj-a");
  });
});
