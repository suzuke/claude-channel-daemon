import { describe, it, expect } from "vitest";
import { generateFleetSystemPrompt } from "../src/fleet-system-prompt.js";

describe("generateFleetSystemPrompt", () => {
  const prompt = () => generateFleetSystemPrompt({
    instanceName: "my-project",
    workingDirectory: "/home/user/project",
  });

  it("includes the instance name", () => {
    expect(prompt()).toContain("**my-project**");
  });

  it("includes the working directory", () => {
    expect(prompt()).toContain("`/home/user/project`");
  });

  it("lists all core fleet tools", () => {
    const result = prompt();
    expect(result).toContain("list_instances");
    expect(result).toContain("send_to_instance");
    expect(result).toContain("start_instance");
    expect(result).toContain("create_instance");
    expect(result).toContain("delete_instance");
    expect(result).toContain("describe_instance");
  });

  it("lists high-level collaboration tools", () => {
    const result = prompt();
    expect(result).toContain("request_information");
    expect(result).toContain("delegate_task");
    expect(result).toContain("report_result");
  });

  it("includes collaboration rules about cross-instance messaging", () => {
    const result = prompt();
    expect(result).toContain("from_instance");
    expect(result).toContain("send_to_instance");
    expect(result).toContain("correlation_id");
    expect(result).toContain("request_kind");
  });

  it("documents structured metadata fields", () => {
    const result = prompt();
    expect(result).toContain("requires_reply");
    expect(result).toContain("task_summary");
    expect(result).toContain('"query"');
    expect(result).toContain('"task"');
    expect(result).toContain('"report"');
    expect(result).toContain('"update"');
  });

  it("warns against using reply tool for cross-instance messages", () => {
    expect(prompt()).toContain("do NOT use the `reply` tool");
  });

  it("advises discovery before assumption", () => {
    const result = prompt();
    expect(result).toContain("list_instances");
    expect(result).toContain("describe_instance");
    expect(result).toContain("Do not guess instance names");
  });

  it("recommends high-level tools over raw send_to_instance", () => {
    expect(prompt()).toContain("Prefer the high-level tools over raw `send_to_instance`");
  });
});
