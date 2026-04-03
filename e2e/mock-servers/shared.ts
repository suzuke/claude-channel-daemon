/**
 * Shared utilities for E2E mock servers and test helpers.
 */
import { createServer as createNetServer } from "node:net";

/** Wait for a condition to become true, polling at interval. Exceptions in fn are treated as false. */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  opts: { timeout?: number; interval?: number; label?: string } = {},
): Promise<void> {
  const timeout = opts.timeout ?? 30_000;
  const interval = opts.interval ?? 500;
  const label = opts.label ?? "condition";
  const start = Date.now();

  while (Date.now() - start < timeout) {
    try {
      if (await fn()) return;
    } catch {
      // Treat exceptions as "not ready yet" — keep polling
    }
    await sleep(interval);
  }

  throw new Error(`Timed out waiting for ${label} after ${timeout}ms`);
}

/** Sleep for ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find a free port by binding to 0 and releasing. */
export function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

/** Cache for VM IPs to avoid repeated `tart ip` calls. */
const vmIpCache = new Map<string, string>();

/** Get VM IP, with caching. */
export async function getVmIp(vmName: string): Promise<string> {
  const cached = vmIpCache.get(vmName);
  if (cached) return cached;

  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout: ip } = await promisify(execFile)("tart", ["ip", vmName], { timeout: 10_000 });
  const vmIp = ip.trim();
  vmIpCache.set(vmName, vmIp);
  return vmIp;
}

/** Run a command via SSH in the Tart VM. */
export async function sshExec(
  vmName: string,
  command: string,
  opts: { timeout?: number; user?: string; password?: string } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const user = opts.user ?? "admin";
  const password = opts.password ?? "admin";
  const timeout = opts.timeout ?? 30_000;

  const vmIp = await getVmIp(vmName);

  try {
    const { stdout, stderr } = await execFileAsync("sshpass", [
      "-p", password,
      "ssh",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "LogLevel=ERROR",
      "-o", "ConnectTimeout=10",
      `${user}@${vmIp}`,
      command,
    ], { timeout });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.code ?? 1 };
  }
}

/** Copy a file to the VM via SCP. */
export async function scpToVm(
  vmName: string,
  localPath: string,
  remotePath: string,
  opts: { user?: string; password?: string } = {},
): Promise<void> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);

  const user = opts.user ?? "admin";
  const password = opts.password ?? "admin";
  const vmIp = await getVmIp(vmName);

  await execFileAsync("sshpass", [
    "-p", password,
    "scp",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "LogLevel=ERROR",
    "-o", "ConnectTimeout=10",
    localPath,
    `${user}@${vmIp}:${remotePath}`,
  ], { timeout: 60_000 });
}

/** Get the host IP as seen from a Tart VM (default gateway). */
export const VM_HOST_IP = "192.168.64.1";
