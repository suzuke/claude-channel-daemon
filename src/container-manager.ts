import { execFile } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve as resolvePath } from "node:path";
import { readPendingPackages, clearPendingPackages, type PendingPackages } from "./install-recorder.js";

function exec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve({ stdout: stdout as string, stderr: stderr as string });
    });
  });
}

const CONTAINER_NAME = "ccd-shared";
const IMAGE_NAME = "ccd-sandbox:latest";
const BAKE_THRESHOLD_COUNT = 3;
const BAKE_THRESHOLD_HOURS = 24;

/**
 * Generate Dockerfile RUN lines from pending packages.
 */
export function generateDockerfilePatch(pending: PendingPackages): string {
  const lines: string[] = [];
  const date = new Date().toISOString().slice(0, 10);
  lines.push(`# Auto-baked from Claude's install history (${date})`);

  if (pending.apt.length > 0) {
    lines.push(
      `RUN sudo apt-get update && sudo apt-get install -y --no-install-recommends ${pending.apt.join(" ")} && sudo rm -rf /var/lib/apt/lists/*`,
    );
  }
  if (pending.pip.length > 0) {
    lines.push(`RUN pip3 install --break-system-packages ${pending.pip.join(" ")}`);
  }
  if (pending.cargo.length > 0) {
    lines.push(`RUN cargo install ${pending.cargo.join(" ")}`);
  }
  if (pending.npm.length > 0) {
    lines.push(`RUN npm install -g ${pending.npm.join(" ")}`);
  }

  return lines.join("\n") + "\n";
}

export interface ContainerOptions {
  projectRoots: string[];
  dataDir: string;
  ccdInstallDir: string;
  extraMounts: string[];
  memory?: string;
  cpus?: string;
  network?: string;
}

export class ContainerManager {
  async isRunning(): Promise<boolean> {
    const { stdout } = await exec("docker", ["ps", "-q", "-f", `name=${CONTAINER_NAME}`]);
    return stdout.trim().length > 0;
  }

  async ensureRunning(opts: ContainerOptions): Promise<void> {
    if (await this.isRunning()) return;

    const home = homedir();
    const network = opts.network ?? "none";
    const args = [
      "run", "-d",
      "--name", CONTAINER_NAME,
      "--restart", "unless-stopped",
      "--label", "ccd=shared",
    ];

    // M3: Network isolation (--add-host is incompatible with --network none)
    args.push("--network", network);
    if (network !== "none") {
      args.push("--add-host", "host.docker.internal:host-gateway");
    }

    // M2: Resource limits
    args.push("--memory", opts.memory ?? "4g", "--cpus", opts.cpus ?? "2");

    for (const raw of opts.projectRoots) {
      const root = raw.startsWith("~") ? raw.replace("~", home) : raw;
      args.push("-v", `${root}:${root}`);
    }

    args.push("-v", `${home}/.claude:${home}/.claude:ro`);
    args.push("-v", `${opts.dataDir}:${opts.dataDir}`);
    args.push("-v", `${opts.ccdInstallDir}:${opts.ccdInstallDir}:ro`);

    // Mount host tmpdir so Claude Code's cwd-tracking temp files work inside the container
    const tmp = tmpdir();
    args.push("-v", `${tmp}:${tmp}`);

    // C6: Validate extra_mounts against allowed directories
    for (const mount of opts.extraMounts) {
      const hostPath = mount.split(":")[0];
      const resolved = resolvePath(hostPath);
      if (resolved.includes("..")) {
        throw new Error(`Extra mount "${mount}" contains path traversal`);
      }
      const allowed = opts.projectRoots.some(r => resolved.startsWith(r)) || resolved.startsWith(home);
      if (!allowed) {
        throw new Error(`Extra mount "${mount}" is outside allowed directories (project roots and $HOME)`);
      }
      args.push("-v", mount);
    }

    args.push(IMAGE_NAME, "tail", "-f", "/dev/null");

    // M4: Fix TOCTOU race – another process may have started the container
    try {
      await exec("docker", args);
    } catch (err) {
      if (await this.isRunning()) return;
      throw err;
    }
  }

  async destroy(): Promise<void> {
    try {
      await exec("docker", ["rm", "-f", CONTAINER_NAME]);
    } catch {
      // Container might not exist
    }
  }

  shouldAutoBake(recordPath: string): boolean {
    const pending = readPendingPackages(recordPath);
    if (pending.count === 0) return false;
    if (pending.count >= BAKE_THRESHOLD_COUNT) return true;
    if (pending.oldestTs) {
      const hoursAgo = (Date.now() - pending.oldestTs.getTime()) / (1000 * 60 * 60);
      if (hoursAgo >= BAKE_THRESHOLD_HOURS) return true;
    }
    return false;
  }

  async autoBake(
    recordPath: string,
    dockerfilePath: string,
  ): Promise<{ success: boolean; packages: PendingPackages }> {
    const pending = readPendingPackages(recordPath);
    if (pending.count === 0) return { success: true, packages: pending };

    const patch = generateDockerfilePatch(pending);

    // Save original Dockerfile for rollback on build failure
    const original = readFileSync(dockerfilePath, "utf-8");
    writeFileSync(dockerfilePath, original + "\n" + patch);

    // Rebuild image
    try {
      await exec("docker", [
        "build",
        "-f", dockerfilePath,
        "-t", IMAGE_NAME,
        dirname(dockerfilePath),
      ]);
    } catch (err) {
      // Rollback Dockerfile on build failure
      writeFileSync(dockerfilePath, original);
      return { success: false, packages: pending };
    }

    // Destroy old container so it restarts with new image
    await this.destroy();

    // Clear pending packages
    clearPendingPackages(recordPath);

    return { success: true, packages: pending };
  }
}
