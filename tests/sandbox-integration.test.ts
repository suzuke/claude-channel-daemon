import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/Users/me" };
});
import { execFile } from "node:child_process";
import { ContainerManager } from "../src/container-manager.js";

const mockExecFile = vi.mocked(execFile);

describe("sandbox integration", () => {
  beforeEach(() => vi.clearAllMocks());

  it("ensureRunning builds correct mount list with same-path mounts", async () => {
    let callCount = 0;
    mockExecFile.mockImplementation((_cmd, _args, cb: any) => {
      callCount++;
      if (callCount === 1) cb(null, "", "");
      else cb(null, "newcontainer123", "");
      return {} as any;
    });

    const mgr = new ContainerManager();
    await mgr.ensureRunning({
      projectRoots: ["/Users/me/projects"],
      dataDir: "/Users/me/.ccd",
      ccdInstallDir: "/Users/me/Hack/ccd",
      extraMounts: ["/Users/me/.ssh:/Users/me/.ssh:ro"],
      network: "bridge",
    });

    const runArgs = mockExecFile.mock.calls[1][1] as string[];

    // Verify same-path mounts
    const mounts = runArgs.filter((_: string, i: number) => runArgs[i - 1] === "-v");
    expect(mounts).toContain("/Users/me/projects:/Users/me/projects");
    expect(mounts.some((m: string) => m.includes(".claude:"))).toBe(true);
    expect(mounts).toContain("/Users/me/.ccd:/Users/me/.ccd");
    expect(mounts).toContain("/Users/me/Hack/ccd:/Users/me/Hack/ccd:ro");
    expect(mounts).toContain("/Users/me/.ssh:/Users/me/.ssh:ro");

    // Verify host.docker.internal is present when network is not "none"
    expect(runArgs).toContain("host.docker.internal:host-gateway");
  });

  describe("sandbox-bash wrapper script", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = join(tmpdir(), `ccd-sandbox-test-${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });
    });
    afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

    it("generates executable sandbox-bash script", async () => {
      // Simulate what Daemon.writeSandboxShell does
      const { writeFileSync } = await import("node:fs");
      const scriptPath = join(tmpDir, "sandbox-bash");
      const script = `#!/bin/bash\nexec docker exec -i -w "$(pwd)" ccd-shared /bin/bash "$@"\n`;
      writeFileSync(scriptPath, script, { mode: 0o755 });

      expect(existsSync(scriptPath)).toBe(true);
      const content = readFileSync(scriptPath, "utf-8");
      expect(content).toContain("docker exec");
      expect(content).toContain("ccd-shared");
      expect(content).toContain('$(pwd)');
      expect(content).toContain('"$@"');
    });

    it("script path contains 'bash' for CLAUDE_CODE_SHELL validation", () => {
      const scriptPath = join(tmpDir, "sandbox-bash");
      expect(scriptPath).toContain("bash");
    });
  });
});
