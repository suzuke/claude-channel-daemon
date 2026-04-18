import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP = join(tmpdir(), "ccd-export-import-test");

function makeDataDir(name: string): string {
  const dir = join(TMP, name, ".agend");
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("ccd export", () => {
  it("exports minimal config files", async () => {
    const { exportConfig } = await import("../src/export-import.js");
    const dataDir = makeDataDir("export-minimal");
    writeFileSync(join(dataDir, "fleet.yaml"), "instances: {}");
    writeFileSync(join(dataDir, ".env"), "CCD_BOT_TOKEN=test");

    const outFile = join(TMP, "test-export.tar.gz");
    await exportConfig(dataDir, outFile, false);

    expect(existsSync(outFile)).toBe(true);

    // Verify contents
    const listing = execSync(`tar tzf "${outFile}"`).toString();
    expect(listing).toContain("fleet.yaml");
    expect(listing).toContain(".env");
    expect(listing).not.toContain("scheduler.db"); // doesn't exist
  });

  it("exports full data dir excluding runtime files", async () => {
    const { exportConfig } = await import("../src/export-import.js");
    const dataDir = makeDataDir("export-full");
    writeFileSync(join(dataDir, "fleet.yaml"), "instances: {}");
    writeFileSync(join(dataDir, ".env"), "CCD_BOT_TOKEN=test");
    writeFileSync(join(dataDir, "fleet.log"), "log line");
    mkdirSync(join(dataDir, "instances", "test"), { recursive: true });
    writeFileSync(
      join(dataDir, "instances", "test", "session-id"),
      "abc-123"
    );
    writeFileSync(
      join(dataDir, "instances", "test", "daemon.log"),
      "log"
    );

    const outFile = join(TMP, "test-full.tar.gz");
    await exportConfig(dataDir, outFile, true);

    const listing = execSync(`tar tzf "${outFile}"`).toString();
    expect(listing).toContain("fleet.yaml");
    expect(listing).toContain("session-id");
    expect(listing).not.toContain("fleet.log");
    expect(listing).not.toContain("daemon.log");
  });
});

describe("ccd import", () => {
  it("imports and backs up existing files", async () => {
    const { exportConfig, importConfig } = await import(
      "../src/export-import.js"
    );

    // Create source and export
    const srcDir = makeDataDir("import-src");
    writeFileSync(join(srcDir, "fleet.yaml"), "instances:\n  new-project: {}");
    writeFileSync(join(srcDir, ".env"), "CCD_BOT_TOKEN=new-token");

    const tarFile = join(TMP, "import-test.tar.gz");
    await exportConfig(srcDir, tarFile, false);

    // Create target with existing config
    const dstDir = makeDataDir("import-dst");
    writeFileSync(join(dstDir, "fleet.yaml"), "instances:\n  old-project: {}");
    writeFileSync(join(dstDir, ".env"), "CCD_BOT_TOKEN=old-token");

    await importConfig(dstDir, tarFile);

    // Check new content was imported
    const fleet = readFileSync(join(dstDir, "fleet.yaml"), "utf-8");
    expect(fleet).toContain("new-project");

    // Check backups were created
    const files = readdirSync(dstDir);
    expect(files.some((f) => f.startsWith("fleet.yaml.bak."))).toBe(true);
    expect(files.some((f) => f.startsWith(".env.bak."))).toBe(true);
  });

  it("rejects archive with traversal entries (zip-slip)", async () => {
    const { importConfig } = await import("../src/export-import.js");

    const dstDir = makeDataDir("import-slip-dst");
    const evilStaging = join(TMP, "evil");
    mkdirSync(join(evilStaging, ".agend"), { recursive: true });
    writeFileSync(join(evilStaging, "pwned.txt"), "owned");

    // Build a tar whose entry path escapes the target dataDir.
    const tarFile = join(TMP, "slip.tar.gz");
    execSync(`tar czf "${tarFile}" -C "${evilStaging}" ".agend" "pwned.txt"`);

    const origExit = process.exit;
    const origErr = console.error;
    let exited = false;
    process.exit = ((code?: number) => {
      exited = true;
      throw new Error(`exit ${code ?? 0}`);
    }) as never;
    console.error = () => {};
    try {
      await importConfig(dstDir, tarFile);
    } catch {
      // expected
    }
    process.exit = origExit;
    console.error = origErr;

    expect(exited).toBe(true);
    // And no stray file escaped.
    expect(existsSync(join(TMP, "pwned.txt"))).toBe(false);
  });

  it("warns about missing paths after import", async () => {
    const { exportConfig, importConfig } = await import(
      "../src/export-import.js"
    );

    const srcDir = makeDataDir("import-paths");
    const fleetContent = [
      "project_roots:",
      "  - /nonexistent/path/abc",
      "instances:",
      "  test:",
      "    working_directory: /nonexistent/workdir",
    ].join("\n");
    writeFileSync(join(srcDir, "fleet.yaml"), fleetContent);

    const tarFile = join(TMP, "path-test.tar.gz");
    await exportConfig(srcDir, tarFile, false);

    const dstDir = makeDataDir("import-paths-dst");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (msg: string) => warnings.push(msg);

    await importConfig(dstDir, tarFile);

    console.warn = origWarn;

    const warningText = warnings.join("\n");
    expect(warningText).toContain("/nonexistent/path/abc");
    expect(warningText).toContain("/nonexistent/workdir");
  });
});
