import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContainerManager, generateDockerfilePatch } from "../src/container-manager.js";
import type { PendingPackages } from "../src/install-recorder.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => "/Users/me" };
});
import { execFile } from "node:child_process";

const mockExecFile = vi.mocked(execFile);

function mockExecSuccess(stdout = "") {
  mockExecFile.mockImplementation((_cmd, _args, cb: any) => {
    cb(null, stdout, "");
    return {} as any;
  });
}

function mockExecFail(msg = "error") {
  mockExecFile.mockImplementation((_cmd, _args, cb: any) => {
    cb(new Error(msg), "", msg);
    return {} as any;
  });
}

describe("ContainerManager", () => {
  const mgr = new ContainerManager();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("isRunning", () => {
    it("returns true when container exists", async () => {
      mockExecSuccess("abc123\n");
      expect(await mgr.isRunning()).toBe(true);
    });

    it("returns false when container does not exist", async () => {
      mockExecSuccess("");
      expect(await mgr.isRunning()).toBe(false);
    });
  });

  describe("ensureRunning", () => {
    it("skips create when already running", async () => {
      mockExecSuccess("abc123\n");
      await mgr.ensureRunning({
        projectRoots: ["/Users/me/projects"],
        dataDir: "/Users/me/.ccd",
        ccdInstallDir: "/Users/me/Hack/ccd",
        extraMounts: [],
      });
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("creates container with correct mounts when not running", async () => {
      let callCount = 0;
      mockExecFile.mockImplementation((_cmd, args, cb: any) => {
        callCount++;
        if (callCount === 1) {
          cb(null, "", "");
        } else {
          cb(null, "newcontainer123", "");
        }
        return {} as any;
      });

      await mgr.ensureRunning({
        projectRoots: ["/Users/me/projects"],
        dataDir: "/Users/me/.ccd",
        ccdInstallDir: "/Users/me/Hack/ccd",
        extraMounts: ["/Users/me/.gitconfig:/Users/me/.gitconfig:ro"],
      });

      expect(callCount).toBe(2);
      const runArgs = mockExecFile.mock.calls[1][1] as string[];
      expect(runArgs).toContain("--name");
      expect(runArgs).toContain("ccd-shared");
      const mountFlags = runArgs.filter((_, i) => runArgs[i - 1] === "-v");
      expect(mountFlags.some(m => m.startsWith("/Users/me/projects:"))).toBe(true);
      expect(mountFlags.some(m => m.includes(".gitconfig"))).toBe(true);
    });
  });

  describe("destroy", () => {
    it("removes container", async () => {
      mockExecSuccess();
      await mgr.destroy();
      const args = mockExecFile.mock.calls[0][1] as string[];
      expect(args).toContain("rm");
      expect(args).toContain("-f");
      expect(args).toContain("ccd-shared");
    });
  });

  describe("shouldAutoBake", () => {
    it("returns false with no packages", () => {
      const tmp = `/tmp/test-bake-empty-${Date.now()}.txt`;
      expect(mgr.shouldAutoBake(tmp)).toBe(false);
    });

    it("returns true with >= 3 packages", async () => {
      const { writeFileSync } = await import("node:fs");
      const tmp = `/tmp/test-bake-count-${Date.now()}.txt`;
      const now = new Date().toISOString();
      writeFileSync(tmp, `apt|curl|${now}\napt|wget|${now}\napt|jq|${now}\n`);
      expect(mgr.shouldAutoBake(tmp)).toBe(true);
    });

    it("returns true with old records (>= 24h)", async () => {
      const { writeFileSync } = await import("node:fs");
      const tmp = `/tmp/test-bake-old-${Date.now()}.txt`;
      const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      writeFileSync(tmp, `apt|curl|${oldDate}\n`);
      expect(mgr.shouldAutoBake(tmp)).toBe(true);
    });

    it("returns false with few recent packages", async () => {
      const { writeFileSync } = await import("node:fs");
      const tmp = `/tmp/test-bake-recent-${Date.now()}.txt`;
      const now = new Date().toISOString();
      writeFileSync(tmp, `apt|curl|${now}\n`);
      expect(mgr.shouldAutoBake(tmp)).toBe(false);
    });
  });
});

describe("generateDockerfilePatch", () => {
  it("generates correct output with sudo for apt", () => {
    const pending: PendingPackages = {
      apt: ["curl", "wget"],
      pip: ["requests"],
      cargo: [],
      npm: ["typescript"],
      count: 4,
      oldestTs: new Date(),
    };
    const patch = generateDockerfilePatch(pending);
    expect(patch).toContain("# Auto-baked from Claude's install history");
    expect(patch).toContain("RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends curl wget && sudo rm -rf /var/lib/apt/lists/*");
    expect(patch).toContain("RUN pip3 install --break-system-packages requests");
    expect(patch).toContain("RUN npm install -g typescript");
    expect(patch).not.toContain("cargo");
  });

  it("generates cargo lines when present", () => {
    const pending: PendingPackages = {
      apt: [],
      pip: [],
      cargo: ["ripgrep", "fd-find"],
      npm: [],
      count: 2,
      oldestTs: new Date(),
    };
    const patch = generateDockerfilePatch(pending);
    expect(patch).toContain("RUN cargo install ripgrep fd-find");
    expect(patch).not.toContain("apt");
    expect(patch).not.toContain("pip");
    expect(patch).not.toContain("npm");
  });
});
