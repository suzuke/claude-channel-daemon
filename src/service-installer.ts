import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import ejs from "ejs";
const { render } = ejs;
import { platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, "..", "templates");

interface ServiceVars {
  label: string;
  execPath: string;
  path?: string;
  workingDirectory: string;
  logPath: string;
}

export function detectPlatform(): "macos" | "linux" {
  return platform() === "darwin" ? "macos" : "linux";
}

// A value ending up inside a systemd unit line (or plist <string>) must not
// contain control characters — a newline would let an attacker close the
// current directive and inject new ones (e.g. ExecStartPost=rm -rf ~).
// The `]]>` guard prevents escaping out of plist CDATA in future templates.
function assertSafeServiceValue(name: string, value: string): void {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(
      `Unsafe service template variable ${name}: contains control characters`,
    );
  }
  if (value.includes("]]>")) {
    throw new Error(
      `Unsafe service template variable ${name}: contains plist CDATA terminator`,
    );
  }
}

function assertAbsolutePath(name: string, value: string): void {
  if (!value.startsWith("/")) {
    throw new Error(`Service template variable ${name} must be an absolute path`);
  }
}

function validateVars(vars: ServiceVars & { path: string }): void {
  assertSafeServiceValue("label", vars.label);
  assertSafeServiceValue("execPath", vars.execPath);
  assertSafeServiceValue("workingDirectory", vars.workingDirectory);
  assertSafeServiceValue("logPath", vars.logPath);
  assertSafeServiceValue("path", vars.path);
  assertAbsolutePath("execPath", vars.execPath);
  assertAbsolutePath("workingDirectory", vars.workingDirectory);
  assertAbsolutePath("logPath", vars.logPath);
  // label is used as a filename component — restrict to safe charset
  if (!/^[A-Za-z0-9._-]+$/.test(vars.label)) {
    throw new Error(`Service label must match [A-Za-z0-9._-]+, got: ${vars.label}`);
  }
}

function withDefaults(vars: ServiceVars): ServiceVars & { path: string } {
  const full = { ...vars, path: vars.path ?? process.env.PATH ?? "" };
  validateVars(full);
  return full;
}

export function renderLaunchdPlist(vars: ServiceVars): string {
  const template = readFileSync(join(templatesDir, "launchd.plist.ejs"), "utf-8");
  return render(template, withDefaults(vars));
}

export function renderSystemdUnit(vars: ServiceVars): string {
  const template = readFileSync(join(templatesDir, "systemd.service.ejs"), "utf-8");
  return render(template, withDefaults(vars));
}

export function uninstallService(label: string): boolean {
  const plat = detectPlatform();
  if (plat === "macos") {
    const plistPath = join(process.env.HOME!, "Library/LaunchAgents", `${label}.plist`);
    if (existsSync(plistPath)) {
      unlinkSync(plistPath);
      return true;
    }
  } else {
    const unitPath = join(process.env.HOME!, ".config/systemd/user", `${label}.service`);
    if (existsSync(unitPath)) {
      unlinkSync(unitPath);
      return true;
    }
  }
  return false;
}

export function installService(vars: ServiceVars): string {
  const plat = detectPlatform();
  if (plat === "macos") {
    const plistPath = join(
      process.env.HOME!,
      "Library/LaunchAgents",
      `${vars.label}.plist`,
    );
    mkdirSync(dirname(plistPath), { recursive: true });
    writeFileSync(plistPath, renderLaunchdPlist(vars));
    return plistPath;
  } else {
    const unitPath = join(
      process.env.HOME!,
      ".config/systemd/user",
      `${vars.label}.service`,
    );
    mkdirSync(dirname(unitPath), { recursive: true });
    writeFileSync(unitPath, renderSystemdUnit(vars));
    return unitPath;
  }
}

const SERVICE_LABEL = "com.agend.fleet";

export function getServicePath(): string | null {
  const plat = detectPlatform();
  if (plat === "macos") {
    const p = join(process.env.HOME!, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
    return existsSync(p) ? p : null;
  } else {
    const p = join(process.env.HOME!, ".config/systemd/user", `${SERVICE_LABEL}.service`);
    return existsSync(p) ? p : null;
  }
}

export function stopService(): boolean {
  const plat = detectPlatform();
  try {
    if (plat === "macos") {
      const uid = process.getuid?.() ?? 501;
      execSync(`launchctl bootout gui/${uid}/${SERVICE_LABEL}`, { stdio: "inherit" });
    } else {
      execSync(`systemctl --user stop ${SERVICE_LABEL}`, { stdio: "inherit" });
    }
    return true;
  } catch {
    return false;
  }
}

export function startService(): boolean {
  const plat = detectPlatform();
  try {
    if (plat === "macos") {
      const plistPath = join(process.env.HOME!, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`);
      if (!existsSync(plistPath)) return false;
      const uid = process.getuid?.() ?? 501;
      const domain = `gui/${uid}`;
      execSync(`launchctl bootstrap ${domain} ${plistPath}`, { stdio: "inherit" });
      execSync(`launchctl enable ${domain}/${SERVICE_LABEL}`, { stdio: "inherit" });
    } else {
      execSync(`systemctl --user start ${SERVICE_LABEL}`, { stdio: "inherit" });
    }
    return true;
  } catch {
    return false;
  }
}

export function activateService(plistPath: string, pidPath: string): void {
  // Kill manually-running fleet if present
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim(), 10);
    try {
      process.kill(pid, "SIGTERM");
      // Wait briefly for process to exit
      for (let i = 0; i < 20; i++) {
        try { process.kill(pid, 0); } catch { break; }
        execSync("sleep 0.1");
      }
    } catch {
      // Process already gone
    }
    try { unlinkSync(pidPath); } catch {}
  }

  const plat = detectPlatform();
  if (plat === "macos") {
    const uid = process.getuid?.() ?? 501;
    const domain = `gui/${uid}`;
    const label = plistPath.replace(/.*\//, "").replace(/\.plist$/, "");
    // Unload if previously loaded (ignore errors)
    try { execSync(`launchctl bootout ${domain}/${label}`, { stdio: "ignore" }); } catch {}
    execSync(`launchctl bootstrap ${domain} ${plistPath}`, { stdio: "inherit" });
    execSync(`launchctl enable ${domain}/${label}`, { stdio: "inherit" });
  } else {
    const serviceName = plistPath.replace(/.*\//, "").replace(/\.service$/, "");
    execSync(`systemctl --user enable --now ${serviceName}`, { stdio: "inherit" });
  }
}
