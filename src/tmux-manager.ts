import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class TmuxManager {
  private windowId: string;

  // Socket isolation: null = use tmux default socket (backward compatible).
  // Set to a name to use `-L <name>` for custom AGEND_HOME isolation.
  private static socketName: string | null = null;

  static setSocketName(name: string | null): void {
    TmuxManager.socketName = name;
  }

  /** Prefix tmux args with -L when socket isolation is active. */
  private static tmuxArgs(args: string[]): string[] {
    if (!TmuxManager.socketName) return args;
    return ["-L", TmuxManager.socketName, ...args];
  }

  constructor(private sessionName: string, windowId: string) {
    this.windowId = windowId;
  }

  // === Static session-level methods ===

  static async ensureSession(name: string): Promise<void> {
    if (await TmuxManager.sessionExists(name)) return;
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["new-session", "-d", "-s", name]));
    } catch (err) {
      if (String(err).includes("duplicate session")) return;
      throw err;
    }
  }

  static async sessionExists(name: string): Promise<boolean> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["has-session", "-t", name]));
      return true;
    } catch { return false; }
  }

  static async killSession(name: string): Promise<void> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["kill-session", "-t", name]));
    } catch {
      // Expected if session doesn't exist
    }
  }

  static async listWindows(sessionName: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
        "list-windows", "-t", sessionName, "-F", "#{window_id}|||#{window_name}"
      ]));
      return stdout.trim().split("\n").filter(Boolean).map(line => {
        const [id, name] = line.split("|||");
        return { id, name };
      });
    } catch { return []; }
  }

  static async getPanePid(sessionName: string, windowId: string): Promise<number | null> {
    try {
      const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
        "list-panes", "-t", `${sessionName}:${windowId}`, "-F", "#{pane_pid}",
      ]));
      const pid = parseInt(stdout.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch { return null; }
  }

  // === Instance window methods ===

  async createWindow(command: string, cwd: string, windowName?: string): Promise<string> {
    const args = ["new-window", "-a", "-t", this.sessionName, "-c", cwd];
    if (windowName) args.push("-n", windowName);
    args.push("-P", "-F", "#{window_id}", command);
    const { stdout } = await exec("tmux", TmuxManager.tmuxArgs(args));
    this.windowId = stdout.trim();
    if (windowName) {
      await exec("tmux", TmuxManager.tmuxArgs(["set-window-option", "-t", `${this.sessionName}:${this.windowId}`, "allow-rename", "off"])).catch(() => {});
    }
    return this.windowId;
  }

  async killWindow(): Promise<void> {
    if (!this.windowId) return;
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["kill-window", "-t", `${this.sessionName}:${this.windowId}`]));
    } catch {
      // Expected if window already exited
    }
  }

  async isWindowAlive(): Promise<boolean> {
    if (!this.windowId) return false;
    try {
      const windows = await TmuxManager.listWindows(this.sessionName);
      return windows.some(w => w.id === this.windowId);
    } catch { return false; }
  }

  async sendKeys(text: string): Promise<boolean> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["send-keys", "-l", "-t", `${this.sessionName}:${this.windowId}`, text]));
      return true;
    } catch { return false; }
  }

  async sendSpecialKey(key: "Enter" | "Escape" | "Up" | "Down"): Promise<boolean> {
    try {
      await exec("tmux", TmuxManager.tmuxArgs(["send-keys", "-t", `${this.sessionName}:${this.windowId}`, key]));
      return true;
    } catch { return false; }
  }

  async pasteText(text: string): Promise<boolean> {
    try {
      const target = `${this.sessionName}:${this.windowId}`;
      const bufName = `paste-${this.windowId}-${Date.now()}`;
      await exec("tmux", TmuxManager.tmuxArgs(["set-buffer", "-b", bufName, "--", text]));
      await exec("tmux", TmuxManager.tmuxArgs(["paste-buffer", "-d", "-b", bufName, "-t", target, "-p"]));
      await new Promise(r => setTimeout(r, 200));
      await exec("tmux", TmuxManager.tmuxArgs(["send-keys", "-t", target, "Enter"]));
      return true;
    } catch { return false; }
  }

  async pipeOutput(logPath: string): Promise<void> {
    const escaped = logPath.replace(/'/g, "'\\''");
    await exec("tmux", TmuxManager.tmuxArgs([
      "pipe-pane", "-t", `${this.sessionName}:${this.windowId}`,
      `cat >> '${escaped}'`,
    ]));
  }

  async capturePane(): Promise<string> {
    const { stdout } = await exec("tmux", TmuxManager.tmuxArgs([
      "capture-pane", "-t", `${this.sessionName}:${this.windowId}`, "-p",
    ]));
    return stdout;
  }

  getWindowId(): string { return this.windowId; }
}
