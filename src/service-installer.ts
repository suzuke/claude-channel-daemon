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

function withDefaults(vars: ServiceVars): ServiceVars & { path: string } {
  return { ...vars, path: vars.path ?? process.env.PATH ?? "" };
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
    execSync(`launchctl load ${plistPath}`, { stdio: "inherit" });
  } else {
    const serviceName = plistPath.replace(/.*\//, "").replace(/\.service$/, "");
    execSync(`systemctl --user enable --now ${serviceName}`, { stdio: "inherit" });
  }
}
