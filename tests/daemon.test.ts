import { describe, it, expect } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { InstanceConfig } from "../src/types.js";
import { ClaudeCodeBackend } from "../src/backend/claude-code.js";
import { HookBasedApproval } from "../src/backend/hook-based-approval.js";
import { MessageBus } from "../src/channel/message-bus.js";

describe("Daemon", () => {
  it("constructs with valid config", () => {
    const config: InstanceConfig = {
      working_directory: "/tmp/test",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { threshold_percentage: 80, max_age_hours: 4, strategy: "hybrid" },
      memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
      log_level: "info",
    };
    const backend = new ClaudeCodeBackend("/tmp/ccd-test-instance");
    const approval = new HookBasedApproval({ messageBus: new MessageBus(), port: 18321 });
    const daemon = new Daemon("test", config, "/tmp/ccd-test-instance", false, undefined, backend, approval);
    expect(daemon).toBeDefined();
  });

  it("constructs with topic mode flag", () => {
    const config: InstanceConfig = {
      working_directory: "/tmp/test",
      restart_policy: { max_retries: 10, backoff: "exponential", reset_after: 300 },
      context_guardian: { threshold_percentage: 80, max_age_hours: 4, strategy: "hybrid" },
      memory: { auto_summarize: false, watch_memory_dir: false, backup_to_sqlite: false },
      log_level: "info",
    };
    const backend = new ClaudeCodeBackend("/tmp/ccd-test-instance");
    const approval = new HookBasedApproval({ messageBus: new MessageBus(), port: 18321 });
    const daemon = new Daemon("test", config, "/tmp/ccd-test-instance", true, undefined, backend, approval);
    expect(daemon).toBeDefined();
  });
});
