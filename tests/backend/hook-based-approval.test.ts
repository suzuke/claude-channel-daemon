// tests/backend/hook-based-approval.test.ts
import { describe, it, expect } from "vitest";
import { HookBasedApproval } from "../../src/backend/hook-based-approval.js";
import { MessageBus } from "../../src/channel/message-bus.js";

describe("HookBasedApproval", () => {
  it("setup() returns PreToolUse hook with correct port", () => {
    const bus = new MessageBus();
    const approval = new HookBasedApproval({ messageBus: bus, port: 18400 });
    const result = approval.setup(18400);

    expect(result.hooks).toBeDefined();
    expect(result.hooks!.PreToolUse).toBeDefined();
    const hooks = result.hooks!.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(hooks[0].matcher).toBe("Bash");
    expect(hooks[0].hooks[0].command).toContain("18400");
  });

  it("setup() hook command includes fail-closed deny on unreachable", () => {
    const bus = new MessageBus();
    const approval = new HookBasedApproval({ messageBus: bus, port: 18321 });
    const result = approval.setup(18321);
    const hooks = result.hooks!.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    expect(hooks[0].hooks[0].command).toContain("permissionDecision");
    expect(hooks[0].hooks[0].command).toContain("deny");
  });
});
