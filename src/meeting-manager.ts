import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { FleetContext } from "./fleet-context.js";

export class MeetingManager {
  private ephemeralTopicMap: Map<string, number> = new Map();

  constructor(private ctx: FleetContext) {}

  /** Get the ephemeral topic ID for an instance (used by fleet-manager for outbound routing) */
  getEphemeralTopicId(instanceName: string): number | undefined {
    return this.ephemeralTopicMap.get(instanceName);
  }

  /** Clean up ephemeral instance resources (worktree, topic map). Called on topic deletion. */
  async cleanupEphemeral(name: string): Promise<void> {
    this.ephemeralTopicMap.delete(name);

    const worktreePath = join("/tmp", `ccd-collab-${name}`);
    if (!existsSync(worktreePath)) return;

    try {
      const { execFileSync } = await import("child_process");
      const mainRepo = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktreePath, stdio: "pipe" }).toString().trim();
      const mainRepoDir = dirname(mainRepo);
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: mainRepoDir, stdio: "pipe" });
      try {
        execFileSync("git", ["branch", "-D", `meet/${name}`], { cwd: mainRepoDir, stdio: "pipe" });
      } catch { /* branch may not exist */ }
      this.ctx.logger.info({ name }, "Cleaned up ephemeral worktree");
    } catch (err) {
      this.ctx.logger.warn({ name, err }, "Failed to clean up ephemeral worktree");
    }
  }

}
