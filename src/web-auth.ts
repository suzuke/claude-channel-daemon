import type { IncomingHttpHeaders } from "node:http";

/**
 * Extract a web-API bearer token from the request, in preferred order:
 *
 *   1. `Authorization: Bearer <token>`  — preferred for cross-origin clients
 *   2. `X-Agend-Token: <token>`         — back-compat with existing agent/cli flows
 *   3. `?token=<token>`                 — back-compat; avoid when possible (leaks to logs)
 *
 * Returns `null` when no token is present.
 */
export function extractWebToken(
  headers: IncomingHttpHeaders,
  searchParams: URLSearchParams,
): string | null {
  const auth = headers["authorization"];
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) {
    const t = auth.slice(7).trim();
    if (t) return t;
  }
  const xAgend = headers["x-agend-token"];
  if (typeof xAgend === "string" && xAgend) return xAgend;
  const q = searchParams.get("token");
  return q ?? null;
}

/**
 * Decide which Origin the server should echo back on CORS responses.
 *
 *  - If the allowlist contains `*`, return `*` (broadest; auth required to access data).
 *  - If the request's Origin is in the allowlist, echo it back (with Vary: Origin).
 *  - Otherwise return `null` → no CORS headers are emitted; the browser blocks the response.
 */
export function computeCorsOrigin(
  reqOrigin: string | null,
  allowedOrigins: readonly string[],
): string | null {
  if (allowedOrigins.includes("*")) return "*";
  if (reqOrigin && allowedOrigins.includes(reqOrigin)) return reqOrigin;
  return null;
}

/** Parse AGEND_WEB_CORS_ORIGINS env var → string[] (empty when unset). */
export function parseCorsOriginsEnv(env: string | undefined): string[] {
  if (!env) return [];
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}
