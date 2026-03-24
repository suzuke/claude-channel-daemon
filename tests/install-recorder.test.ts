import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { unlinkSync, readFileSync } from "node:fs";
import {
  parseInstallCommand,
  recordInstall,
  readPendingPackages,
  clearPendingPackages,
} from "../src/install-recorder.js";

describe("parseInstallCommand", () => {
  it("detects pip install", () => {
    expect(parseInstallCommand("pip install pymupdf")).toEqual({
      type: "pip",
      packages: ["pymupdf"],
    });
    expect(
      parseInstallCommand("pip3 install --break-system-packages yt-dlp requests")
    ).toEqual({
      type: "pip",
      packages: ["yt-dlp", "requests"],
    });
  });

  it("detects apt-get install", () => {
    expect(parseInstallCommand("sudo apt-get install -y ffmpeg")).toEqual({
      type: "apt",
      packages: ["ffmpeg"],
    });
    expect(
      parseInstallCommand(
        "apt-get install -y --no-install-recommends ffmpeg curl"
      )
    ).toEqual({
      type: "apt",
      packages: ["ffmpeg", "curl"],
    });
  });

  it("detects cargo install", () => {
    expect(parseInstallCommand("cargo install ripgrep")).toEqual({
      type: "cargo",
      packages: ["ripgrep"],
    });
  });

  it("ignores cargo install edge cases (--git, --path, URLs)", () => {
    expect(
      parseInstallCommand("cargo install --git https://github.com/foo/bar")
    ).toBeNull();
    expect(
      parseInstallCommand("cargo install --path ./my-crate")
    ).toBeNull();
  });

  it("handles cargo install with --git and crate name", () => {
    expect(
      parseInstallCommand("cargo install ripgrep --git https://github.com/BurntSushi/ripgrep")
    ).toEqual({
      type: "cargo",
      packages: ["ripgrep"],
    });
  });

  it("detects npm install -g", () => {
    expect(parseInstallCommand("npm install -g typescript")).toEqual({
      type: "npm",
      packages: ["typescript"],
    });
  });

  it("detects apt install (without -get)", () => {
    expect(parseInstallCommand("sudo apt install -y ffmpeg")).toEqual({
      type: "apt",
      packages: ["ffmpeg"],
    });
  });

  it("returns null for non-install commands", () => {
    expect(parseInstallCommand("ls -la")).toBeNull();
    expect(parseInstallCommand("pip list")).toBeNull();
    expect(parseInstallCommand("npm install")).toBeNull(); // local install, not -g
    expect(parseInstallCommand("git commit")).toBeNull();
  });

  it("ignores pip install edge cases (files, URLs, local paths)", () => {
    expect(parseInstallCommand("pip install -r requirements.txt")).toBeNull();
    expect(parseInstallCommand("pip install .")).toBeNull();
    expect(parseInstallCommand("pip install -e .")).toBeNull();
    expect(
      parseInstallCommand("pip install git+https://github.com/foo/bar")
    ).toBeNull();
    expect(parseInstallCommand("pip install ./my-package")).toBeNull();
  });

  it("handles multiline commands (extracts install from pipeline)", () => {
    expect(
      parseInstallCommand("apt-get update && apt-get install -y ffmpeg")
    ).toEqual({
      type: "apt",
      packages: ["ffmpeg"],
    });
  });

  it("handles pip install with -c (constraint) flag", () => {
    expect(
      parseInstallCommand("pip install -c constraints.txt flask")
    ).toEqual({
      type: "pip",
      packages: ["flask"],
    });
  });

  it("handles pip install with --requirement long form", () => {
    expect(
      parseInstallCommand("pip install --requirement requirements.txt")
    ).toBeNull();
  });

  it("handles pip install with --editable long form", () => {
    expect(parseInstallCommand("pip install --editable .")).toBeNull();
  });

  it("ignores pip install with URL containing ://", () => {
    expect(
      parseInstallCommand("pip install https://example.com/package.whl")
    ).toBeNull();
  });

  it("ignores pip install with local path starting with /", () => {
    expect(
      parseInstallCommand("pip install /home/user/my-package")
    ).toBeNull();
  });

  it("ignores pip install with .cfg file", () => {
    expect(parseInstallCommand("pip install setup.cfg")).toBeNull();
  });

  it("ignores pip install with .toml file", () => {
    expect(parseInstallCommand("pip install pyproject.toml")).toBeNull();
  });

  it("handles multiple packages with pip where some are filtered", () => {
    expect(
      parseInstallCommand("pip install -r requirements.txt flask gunicorn")
    ).toEqual({
      type: "pip",
      packages: ["flask", "gunicorn"],
    });
  });
});

describe("recordInstall", () => {
  const recordPath = join(tmpdir(), `test-install-recorder-${process.pid}.txt`);

  beforeEach(() => {
    try {
      unlinkSync(recordPath);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      unlinkSync(recordPath);
    } catch {
      // ignore
    }
  });

  it("creates file and records packages", () => {
    recordInstall(recordPath, { type: "pip", packages: ["flask"] });
    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("pip|flask|");
  });

  it("appends to existing file", () => {
    recordInstall(recordPath, { type: "pip", packages: ["flask"] });
    recordInstall(recordPath, { type: "apt", packages: ["curl"] });
    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("pip|flask|");
    expect(content).toContain("apt|curl|");
  });

  it("deduplicates when recording the same package twice", () => {
    recordInstall(recordPath, { type: "pip", packages: ["flask"] });
    recordInstall(recordPath, { type: "pip", packages: ["flask"] });
    const content = readFileSync(recordPath, "utf-8");
    const lines = content.trim().split("\n");
    const flaskLines = lines.filter((l) => l.startsWith("pip|flask|"));
    expect(flaskLines).toHaveLength(1);
  });

  it("allows same package name for different types", () => {
    recordInstall(recordPath, { type: "pip", packages: ["foo"] });
    recordInstall(recordPath, { type: "npm", packages: ["foo"] });
    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("pip|foo|");
    expect(content).toContain("npm|foo|");
  });

  it("records multiple packages in one call", () => {
    recordInstall(recordPath, {
      type: "pip",
      packages: ["flask", "gunicorn"],
    });
    const content = readFileSync(recordPath, "utf-8");
    expect(content).toContain("pip|flask|");
    expect(content).toContain("pip|gunicorn|");
  });
});

describe("readPendingPackages", () => {
  const recordPath = join(
    tmpdir(),
    `test-install-recorder-read-${process.pid}.txt`
  );

  beforeEach(() => {
    try {
      unlinkSync(recordPath);
    } catch {
      // ignore
    }
  });

  afterEach(() => {
    try {
      unlinkSync(recordPath);
    } catch {
      // ignore
    }
  });

  it("returns empty result for non-existent file", () => {
    const result = readPendingPackages("/tmp/nonexistent-file-xyz.txt");
    expect(result.count).toBe(0);
    expect(result.apt).toEqual([]);
    expect(result.pip).toEqual([]);
    expect(result.cargo).toEqual([]);
    expect(result.npm).toEqual([]);
    expect(result.oldestTs).toBeNull();
  });

  it("returns correct counts and categories", () => {
    recordInstall(recordPath, { type: "pip", packages: ["flask"] });
    recordInstall(recordPath, { type: "apt", packages: ["curl", "wget"] });
    recordInstall(recordPath, { type: "cargo", packages: ["ripgrep"] });
    recordInstall(recordPath, { type: "npm", packages: ["typescript"] });

    const result = readPendingPackages(recordPath);
    expect(result.count).toBe(5);
    expect(result.pip).toEqual(["flask"]);
    expect(result.apt).toEqual(["curl", "wget"]);
    expect(result.cargo).toEqual(["ripgrep"]);
    expect(result.npm).toEqual(["typescript"]);
    expect(result.oldestTs).toBeInstanceOf(Date);
  });

  it("deduplicates entries in the file", () => {
    // Manually write duplicate entries
    const { writeFileSync } = require("node:fs");
    writeFileSync(
      recordPath,
      "pip|flask|2026-01-01T00:00:00Z\npip|flask|2026-01-02T00:00:00Z\n"
    );

    const result = readPendingPackages(recordPath);
    expect(result.pip).toEqual(["flask"]);
    expect(result.count).toBe(1);
  });

  it("tracks oldest timestamp", () => {
    const { writeFileSync } = require("node:fs");
    writeFileSync(
      recordPath,
      "pip|flask|2026-01-01T00:00:00Z\npip|gunicorn|2026-01-05T00:00:00Z\n"
    );

    const result = readPendingPackages(recordPath);
    expect(result.oldestTs).toEqual(new Date("2026-01-01T00:00:00Z"));
  });
});

describe("clearPendingPackages", () => {
  const recordPath = join(
    tmpdir(),
    `test-install-recorder-clear-${process.pid}.txt`
  );

  afterEach(() => {
    try {
      unlinkSync(recordPath);
    } catch {
      // ignore
    }
  });

  it("clears the file contents", () => {
    recordInstall(recordPath, { type: "pip", packages: ["flask"] });
    expect(readPendingPackages(recordPath).count).toBe(1);

    clearPendingPackages(recordPath);
    expect(readPendingPackages(recordPath).count).toBe(0);
  });

  it("creates file if it does not exist", () => {
    clearPendingPackages(recordPath);
    const content = readFileSync(recordPath, "utf-8");
    expect(content).toBe("");
  });
});
