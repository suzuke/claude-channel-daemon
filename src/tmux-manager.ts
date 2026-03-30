import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export class TmuxManager {
  private windowId: string;

  constructor(private sessionName: string, windowId: string) {
    this.windowId = windowId;
  }

  // === Static session-level methods ===

  static async ensureSession(name: string): Promise<void> {
    if (await TmuxManager.sessionExists(name)) return;
    await exec("tmux", ["new-session", "-d", "-s", name]);
  }

  static async sessionExists(name: string): Promise<boolean> {
    try {
      await exec("tmux", ["has-session", "-t", name]);
      return true;
    } catch { return false; }
  }

  static async killSession(name: string): Promise<void> {
    try {
      await exec("tmux", ["kill-session", "-t", name]);
    } catch (err: unknown) {
      // Expected if session doesn't exist; unexpected errors logged via stderr
    }
  }

  static async listWindows(sessionName: string): Promise<Array<{ id: string; name: string }>> {
    try {
      const { stdout } = await exec("tmux", [
        "list-windows", "-t", sessionName, "-F", "#{window_id}\t#{window_name}"
      ]);
      return stdout.trim().split("\n").filter(Boolean).map(line => {
        const [id, name] = line.split("\t");
        return { id, name };
      });
    } catch { return []; }
  }

  // === Instance window methods ===

  async createWindow(command: string, cwd: string, windowName?: string): Promise<string> {
    const args = ["new-window", "-t", this.sessionName, "-c", cwd];
    if (windowName) args.push("-n", windowName);
    args.push("-P", "-F", "#{window_id}", command);
    const { stdout } = await exec("tmux", args);
    this.windowId = stdout.trim();
    // Prevent the child process from overriding the window name via escape sequences
    if (windowName) {
      await exec("tmux", ["set-window-option", "-t", `${this.sessionName}:${this.windowId}`, "allow-rename", "off"]).catch(() => {});
    }
    return this.windowId;
  }

  async killWindow(): Promise<void> {
    if (!this.windowId) return;
    try {
      await exec("tmux", ["kill-window", "-t", `${this.sessionName}:${this.windowId}`]);
    } catch (err: unknown) {
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
      await exec("tmux", ["send-keys", "-l", "-t", `${this.sessionName}:${this.windowId}`, text]);
      return true;
    } catch { return false; }
  }

  async sendSpecialKey(key: "Enter" | "Escape" | "Up" | "Down"): Promise<boolean> {
    try {
      await exec("tmux", ["send-keys", "-t", `${this.sessionName}:${this.windowId}`, key]);
      return true;
    } catch { return false; }
  }

  /** Paste text via bracketed paste (safe for CLIs with single-char hotkeys like Gemini's '!') */
  async pasteText(text: string): Promise<boolean> {
    try {
      const target = `${this.sessionName}:${this.windowId}`;
      await exec("tmux", ["set-buffer", "--", text]);
      await exec("tmux", ["paste-buffer", "-t", target, "-p"]);
      await exec("tmux", ["send-keys", "-t", target, "Enter"]);
      return true;
    } catch { return false; }
  }

  async pipeOutput(logPath: string): Promise<void> {
    const escaped = logPath.replace(/'/g, "'\\''");
    await exec("tmux", [
      "pipe-pane", "-t", `${this.sessionName}:${this.windowId}`,
      `cat >> '${escaped}'`,
    ]);
  }

  async capturePane(): Promise<string> {
    const { stdout } = await exec("tmux", [
      "capture-pane", "-t", `${this.sessionName}:${this.windowId}`, "-p",
    ]);
    return stdout;
  }

  getWindowId(): string { return this.windowId; }
}
