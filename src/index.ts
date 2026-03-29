// TODO(Task 15): ProcessManager removed — will be replaced by TmuxManager-based orchestrator
// export { ProcessManager, STATUSLINE_FILE } from "./process-manager.js";
export { TmuxManager } from "./tmux-manager.js";
export { ContextGuardian } from "./context-guardian.js";
export { loadFleetConfig, DEFAULT_INSTANCE_CONFIG } from "./config.js";
export { createLogger } from "./logger.js";
export { installService, detectPlatform } from "./service-installer.js";
export type { ContextStatus, StatusLineData, InstanceConfig, ChannelConfig, AccessConfig } from "./types.js";

// Channel adapter types — for external adapter authors (ccd-adapter-*)
export type {
  ChannelAdapter,
  SendOpts,
  SentMessage,
  InboundMessage,
  Attachment,
  PermissionPrompt,
  ApprovalHandle,
  ApprovalResponse,
  Choice,
  AlertData,
  InstanceStatusData,
  QueuedMessage,
} from "./channel/types.js";
export type { AdapterOpts, AdapterFactory } from "./channel/factory.js";
