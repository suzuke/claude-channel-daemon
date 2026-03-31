import type { Logger } from "./logger.js";

/**
 * Wrap an async EventEmitter callback so unhandled errors are logged
 * instead of crashing the process via unhandled rejection.
 */
export function safeHandler<T extends unknown[]>(
  fn: (...args: T) => void | Promise<void>,
  logger: Logger,
  context: string,
): (...args: T) => void {
  return (...args: T) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === "function") {
        result.catch((err: unknown) => {
          logger.error({ err, context }, "Unhandled error in async handler");
        });
      }
    } catch (err) {
      logger.error({ err, context }, "Unhandled error in sync handler");
    }
  };
}
