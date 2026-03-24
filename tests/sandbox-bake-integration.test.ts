import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseInstallCommand,
  recordInstall,
  readPendingPackages,
  clearPendingPackages,
} from "../src/install-recorder.js";
import { generateDockerfilePatch } from "../src/container-manager.js";

describe("sandbox bake integration", () => {
  const recordPath = join(tmpdir(), `test-installed-packages-${Date.now()}.txt`);

  beforeEach(() => {
    if (existsSync(recordPath)) unlinkSync(recordPath);
  });
  afterEach(() => {
    if (existsSync(recordPath)) unlinkSync(recordPath);
  });

  it("full flow: detect → record → read → generate patch", () => {
    const cmds = [
      "pip3 install --break-system-packages pymupdf",
      "sudo apt-get install -y ffmpeg",
      "cargo install ripgrep",
      "ls -la", // not an install
      "pip install -r requirements.txt", // should be ignored
      "npm install -g typescript",
    ];

    for (const cmd of cmds) {
      const install = parseInstallCommand(cmd);
      if (install) recordInstall(recordPath, install);
    }

    const pending = readPendingPackages(recordPath);
    expect(pending.count).toBe(4);
    expect(pending.pip).toEqual(["pymupdf"]);
    expect(pending.apt).toEqual(["ffmpeg"]);
    expect(pending.cargo).toEqual(["ripgrep"]);
    expect(pending.npm).toEqual(["typescript"]);

    const patch = generateDockerfilePatch(pending);
    expect(patch).toContain("sudo apt-get");
    expect(patch).toContain("ffmpeg");
    expect(patch).toContain("pip3 install --break-system-packages pymupdf");
    expect(patch).toContain("cargo install ripgrep");
    expect(patch).toContain("npm install -g typescript");
    expect(patch).toContain("# Auto-baked");

    clearPendingPackages(recordPath);
    expect(readPendingPackages(recordPath).count).toBe(0);
  });

  it("deduplicates across multiple record calls", () => {
    const install = parseInstallCommand("pip install requests")!;
    recordInstall(recordPath, install);
    recordInstall(recordPath, install); // same again
    recordInstall(recordPath, install); // third time

    const pending = readPendingPackages(recordPath);
    expect(pending.pip).toEqual(["requests"]);
    expect(pending.count).toBe(1);
  });

  it("handles mixed installs from multiple sessions", () => {
    // Session 1
    const pip1 = parseInstallCommand("pip install flask")!;
    recordInstall(recordPath, pip1);

    // Session 2 installs same + new
    const pip2 = parseInstallCommand("pip install flask django")!;
    recordInstall(recordPath, pip2);

    const apt1 = parseInstallCommand("sudo apt install -y curl wget")!;
    recordInstall(recordPath, apt1);

    const pending = readPendingPackages(recordPath);
    expect(pending.pip).toEqual(["flask", "django"]);
    expect(pending.apt).toEqual(["curl", "wget"]);
    expect(pending.count).toBe(4);
  });
});
