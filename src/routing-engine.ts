import type { FleetConfig } from "./types.js";
import { type RouteTarget } from "./fleet-context.js";

/**
 * Manages the topic→instance routing table.
 * All topic IDs are normalized to strings to avoid snowflake precision loss.
 */
export class RoutingEngine {
  private table = new Map<string, RouteTarget>();

  /** Rebuild routing table from fleet config. Returns summary string for logging. */
  rebuild(config: FleetConfig): string {
    this.table.clear();
    for (const [name, inst] of Object.entries(config.instances)) {
      if (inst.topic_id != null) {
        this.table.set(String(inst.topic_id), {
          kind: inst.general_topic ? "general" : "instance",
          name,
        });
      }
    }
    return [...this.table.entries()].map(([tid, t]) => `#${tid}→${t.name}`).join(", ");
  }

  /** Resolve a thread ID to a route target. */
  resolve(threadId: string): RouteTarget | undefined {
    return this.table.get(threadId);
  }

  /** Register a new topic→instance mapping. */
  register(topicId: number | string, target: RouteTarget): void {
    this.table.set(String(topicId), target);
  }

  /** Remove a topic from the routing table. */
  unregister(topicId: number | string): void {
    this.table.delete(String(topicId));
  }

  /** Iterate over all routes. */
  entries(): IterableIterator<[string, RouteTarget]> {
    return this.table.entries();
  }

  /** Get the underlying map (for FleetContext compatibility). */
  get map(): Map<string, RouteTarget> {
    return this.table;
  }

  get size(): number {
    return this.table.size;
  }
}
