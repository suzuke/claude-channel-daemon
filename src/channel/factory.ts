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
  switch (config.type) {
    case "telegram": {
      const { TelegramAdapter } = await import("./adapters/telegram.js");
      return new TelegramAdapter(opts);
    }
    case "discord": {
      const { DiscordAdapter } = await import("./adapters/discord.js");
      return new DiscordAdapter({
        ...opts,
        guildId: config.group_id != null ? String(config.group_id) : "",
        categoryName: (config.options?.category_name as string) ?? undefined,
        generalChannelId: (config.options?.general_channel_id as string) ?? undefined,
      });
    }
    default: {
      // External adapter — try canonical name, then bare name
      const candidates = [`ccd-adapter-${config.type}`, config.type];
      let factory: AdapterFactory | undefined;

      for (const pkg of candidates) {
        try {
          const mod = await import(pkg);
          factory = mod.default;
          break;
        } catch {
          continue;
        }
      }

      if (!factory) {
        throw new Error(
          `Channel adapter "${config.type}" not found. ` +
          `Install it: npm install ccd-adapter-${config.type}`
        );
      }

      return factory(config, opts);
    }
  }
}
