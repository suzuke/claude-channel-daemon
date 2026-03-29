import { describe, it, expect } from "vitest";
import { generateFleetSystemPrompt } from "../src/fleet-system-prompt.js";

describe("generateFleetSystemPrompt", () => {
  it("includes the instance name", () => {
    const result = generateFleetSystemPrompt({
      instanceName: "my-project",
      workingDirectory: "/home/user/project",
    });
    expect(result).toContain("**my-project**");
  });

  it("includes the working directory", () => {
    const result = generateFleetSystemPrompt({
      instanceName: "test",
      workingDirectory: "/tmp/test-dir",
    });
    expect(result).toContain("`/tmp/test-dir`");
  });

  it("lists all fleet tools", () => {
    const result = generateFleetSystemPrompt({
      instanceName: "test",
      workingDirectory: "/tmp",
    });
    expect(result).toContain("list_instances");
    expect(result).toContain("send_to_instance");
    expect(result).toContain("start_instance");
    expect(result).toContain("create_instance");
    expect(result).toContain("delete_instance");
  });

  it("includes collaboration rules about cross-instance messaging", () => {
    const result = generateFleetSystemPrompt({
      instanceName: "test",
      workingDirectory: "/tmp",
    });
    expect(result).toContain("from_instance");
    expect(result).toContain("send_to_instance");
    expect(result).toContain("correlation_id");
    expect(result).toContain("request_kind");
  });

  it("warns against using reply tool for cross-instance messages", () => {
    const result = generateFleetSystemPrompt({
      instanceName: "test",
      workingDirectory: "/tmp",
    });
    expect(result).toContain("do NOT use the `reply` tool");
  });

  it("advises discovery before assumption", () => {
    const result = generateFleetSystemPrompt({
      instanceName: "test",
      workingDirectory: "/tmp",
    });
    expect(result).toContain("list_instances");
    expect(result).toContain("Do not guess instance names");
  });
});
