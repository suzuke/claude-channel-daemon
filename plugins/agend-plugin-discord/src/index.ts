/**
 * AgEnD Discord adapter plugin.
 *
 * Install: npm install agend-plugin-discord
 *
 * fleet.yaml:
 *   channel:
 *     type: discord
 */
import type { ChannelAdapter } from "@suzuke/agend/channel";
import type { ChannelConfig } from "@suzuke/agend/types";
import type { AccessManager } from "@suzuke/agend/channel/access-manager";
import { DiscordAdapter } from "./discord-adapter.js";

interface AdapterOpts {
  id: string;
  botToken: string;
  accessManager: AccessManager;
  inboxDir: string;
}

/** Plugin factory — default export for AgEnD plugin loader. */
export default function createAdapter(config: ChannelConfig, opts: AdapterOpts): ChannelAdapter {
  return new DiscordAdapter({
    ...opts,
    guildId: config.group_id != null ? String(config.group_id) : "",
    categoryName: (config.options?.category_name as string) ?? undefined,
    generalChannelId: (config.options?.general_channel_id as string) ?? undefined,
  });
}

export { DiscordAdapter } from "./discord-adapter.js";
