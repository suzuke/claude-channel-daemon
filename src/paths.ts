import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

/** Resolve the AgEnD data directory. Override with AGEND_HOME env var. */
export function getAgendHome(): string {
  return process.env.AGEND_HOME || join(homedir(), ".agend");
}

/** Tmux session name — unique per AGEND_HOME to avoid cross-instance interference. */
export function getTmuxSessionName(): string {
  const home = getAgendHome();
  const defaultHome = join(homedir(), ".agend");
  if (home === defaultHome) return "agend";
  // sha256 instead of md5: this hash is not security-critical (we just need a
  // short stable suffix so two custom AGEND_HOME values don't collide on the
  // tmux session/socket namespace), but md5 trips FIPS-mode Node and security
  // scanners. The suffix value WILL change for users with a custom
  // AGEND_HOME — that only affects an in-memory tmux session/socket name, so
  // a single daemon restart resyncs cleanly (any orphan tmux session under
  // the old name can be killed manually).
  return "agend-" + createHash("sha256").update(home).digest("hex").slice(0, 6);
}

/**
 * Tmux socket name for -L flag. Returns null for default AGEND_HOME
 * (backward compatible — uses tmux's default socket). Custom AGEND_HOME
 * gets a unique socket to isolate tmux servers.
 */
export function getTmuxSocketName(): string | null {
  const home = getAgendHome();
  const defaultHome = join(homedir(), ".agend");
  if (home === defaultHome) return null;
  // sha256 instead of md5: this hash is not security-critical (we just need a
  // short stable suffix so two custom AGEND_HOME values don't collide on the
  // tmux session/socket namespace), but md5 trips FIPS-mode Node and security
  // scanners. The suffix value WILL change for users with a custom
  // AGEND_HOME — that only affects an in-memory tmux session/socket name, so
  // a single daemon restart resyncs cleanly (any orphan tmux session under
  // the old name can be killed manually).
  return "agend-" + createHash("sha256").update(home).digest("hex").slice(0, 6);
}
