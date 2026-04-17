/**
 * zod schemas for outbound tool-call args.
 *
 * Single source of truth for both runtime validation (in outbound-handlers.ts)
 * and JSON Schema generation for MCP tool listings (in channel/mcp-tools.ts).
 */
import { z } from "zod";

// ── Shared field schemas ────────────────────────────────────────────────
// Reused across multiple tools; declaring once avoids drift.

const NonEmptyString = z.string().min(1);

// ── Fleet Templates ─────────────────────────────────────────────────────

export const TeardownDeploymentArgs = z.object({
  name: NonEmptyString.describe("Deployment name (as used in deploy_template)."),
});

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Validate raw args with a zod schema. Returns a tagged result so callers can
 * propagate a clean error message to the agent without leaking internals.
 */
export function validateArgs<T>(
  schema: z.ZodType<T>,
  args: unknown,
  toolName: string,
): { ok: true; data: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(args);
  if (parsed.success) return { ok: true, data: parsed.data };
  const detail = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(args)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error: `Invalid args for ${toolName}: ${detail}` };
}
