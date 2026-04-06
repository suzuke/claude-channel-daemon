import type { ChannelAdapter } from "./types.js";
import type { ChannelConfig } from "../types.js";
import type { AccessManager } from "./access-manager.js";

export interface AdapterOpts {
  id: string;
  botToken: string;
  accessManager: AccessManager;
  inboxDir: string;
}

/** Factory function that external adapter packages must default-export. */
export type AdapterFactory = (config: ChannelConfig, opts: AdapterOpts) => ChannelAdapter;

export async function createAdapter(config: ChannelConfig, opts: AdapterOpts): Promise<ChannelAdapter> {
  // Built-in adapters
  if (config.type === "telegram") {
    const { TelegramAdapter } = await import("./adapters/telegram.js");
    return new TelegramAdapter({ ...opts, apiRoot: config.telegram_api_root });
  }

  // Plugin adapters — try multiple package name conventions
  const candidates = [
    `agend-plugin-${config.type}`,   // new convention: agend-plugin-discord
    `agend-adapter-${config.type}`,  // legacy convention: agend-adapter-discord
    config.type,                      // bare name: discord (if someone names their package that)
  ];

  for (const pkg of candidates) {
    try {
      const mod = await import(pkg);
      const factory = mod.default;
      // Support both: factory function and object with createAdapter method
      if (typeof factory === "function") return factory(config, opts);
      if (factory?.createAdapter) return factory.createAdapter(config, opts);
    } catch {
      continue;
    }
  }

  throw new Error(
    `Channel adapter "${config.type}" not found. ` +
    `Install the plugin: npm install agend-plugin-${config.type}`
  );
}
