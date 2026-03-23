export interface ApprovalStrategy {
  /**
   * Return hook definitions to merge into CLI settings.
   * Hook-based: returns { hooks: { PreToolUse: [...] } }
   * Shell-wrapper: returns {} (no hooks needed)
   */
  setup(port: number): { hooks?: Record<string, unknown> };

  /** Start the approval service. Returns the actual port. */
  start(): Promise<number>;

  /** Stop the approval service */
  stop(): Promise<void>;
}
