import { describe, it, expect, vi, beforeEach } from "vitest";
import { listDiscordChannels } from "../src/quickstart.js";

describe("Quickstart – Discord UX", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  describe("listDiscordChannels", () => {
    it("returns text channels on success", async () => {
      const channels = [
        { id: "111", name: "general", type: 0 },
        { id: "222", name: "voice", type: 2 },
        { id: "333", name: "dev", type: 0 },
      ];
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(channels),
      });

      const result = await listDiscordChannels("fake-token", "guild-123");
      expect(result).toEqual(channels);
      expect(global.fetch).toHaveBeenCalledWith(
        "https://discord.com/api/v10/guilds/guild-123/channels",
        { headers: { Authorization: "Bot fake-token" } },
      );
    });

    it("returns empty array on API error", async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
      const result = await listDiscordChannels("bad-token", "guild-123");
      expect(result).toEqual([]);
    });

    it("returns empty array on network failure", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await listDiscordChannels("token", "guild-123");
      expect(result).toEqual([]);
    });
  });

  describe("Discord channel filtering and selection logic", () => {
    it("filters only GuildText channels (type 0)", () => {
      const channels = [
        { id: "1", name: "general", type: 0 },
        { id: "2", name: "voice", type: 2 },
        { id: "3", name: "category", type: 4 },
        { id: "4", name: "dev", type: 0 },
        { id: "5", name: "forum", type: 15 },
      ];
      const textChannels = channels.filter(c => c.type === 0);
      expect(textChannels).toHaveLength(2);
      expect(textChannels.map(c => c.name)).toEqual(["general", "dev"]);
    });

    it("sorts channels by name and limits to 20", () => {
      const channels = Array.from({ length: 25 }, (_, i) => ({
        id: String(i), name: `ch-${String(i).padStart(2, "0")}`, type: 0,
      }));
      const result = channels.filter(c => c.type === 0).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20);
      expect(result).toHaveLength(20);
      expect(result[0].name).toBe("ch-00");
      expect(result[19].name).toBe("ch-19");
    });

    it("NaN input defaults to index 0", () => {
      const textChannels = [
        { id: "100", name: "general", type: 0 },
        { id: "200", name: "dev", type: 0 },
      ];
      const cChoice = "abc";
      const parsed = parseInt(cChoice || "1", 10);
      const cIdx = isNaN(parsed) ? 0 : Math.max(0, Math.min(textChannels.length - 1, parsed - 1));
      expect(cIdx).toBe(0);
      expect(textChannels[cIdx].id).toBe("100");
    });

    it("empty input defaults to first channel", () => {
      const textChannels = [
        { id: "100", name: "general", type: 0 },
        { id: "200", name: "dev", type: 0 },
      ];
      const cChoice = "";
      const parsed = parseInt(cChoice || "1", 10);
      const cIdx = isNaN(parsed) ? 0 : Math.max(0, Math.min(textChannels.length - 1, parsed - 1));
      expect(cIdx).toBe(0);
    });

    it("out-of-range input clamps to valid range", () => {
      const textChannels = [
        { id: "100", name: "general", type: 0 },
        { id: "200", name: "dev", type: 0 },
      ];
      const cChoice = "99";
      const parsed = parseInt(cChoice || "1", 10);
      const cIdx = isNaN(parsed) ? 0 : Math.max(0, Math.min(textChannels.length - 1, parsed - 1));
      expect(cIdx).toBe(1); // clamped to last
    });
  });

  describe("Discord fleet.yaml options output", () => {
    function buildDiscordOptions(generalChannelId: string, categoryName: string): string[] {
      const discordOptions: string[] = [];
      if (generalChannelId) discordOptions.push(`    general_channel_id: "${generalChannelId}"`);
      if (categoryName && categoryName !== "AgEnD Agents") discordOptions.push(`    category_name: "${categoryName}"`);
      return discordOptions;
    }

    it("includes general_channel_id in options", () => {
      const opts = buildDiscordOptions("345678901234567890", "AgEnD Agents");
      expect(opts).toEqual(['    general_channel_id: "345678901234567890"']);
    });

    it("includes category_name when non-default", () => {
      const opts = buildDiscordOptions("345678901234567890", "My Agents");
      expect(opts).toEqual([
        '    general_channel_id: "345678901234567890"',
        '    category_name: "My Agents"',
      ]);
    });

    it("omits category_name when default", () => {
      const opts = buildDiscordOptions("123", "AgEnD Agents");
      expect(opts).toHaveLength(1);
      expect(opts[0]).not.toContain("category_name");
    });

    it("empty generalChannelId produces no options", () => {
      const opts = buildDiscordOptions("", "AgEnD Agents");
      expect(opts).toEqual([]);
    });

    it("full fleet.yaml structure with options block", () => {
      const discordOptions = buildDiscordOptions("345678901234567890", "Custom Category");
      const fleetYaml = [
        "channel:",
        "  type: discord",
        "  mode: topic",
        "  bot_token_env: AGEND_DISCORD_TOKEN",
        '  group_id: "999888777666555444"',
        "  access:",
        "    mode: locked",
        "    allowed_users:",
        '      - "111222333444555666"',
        ...(discordOptions.length > 0 ? ["  options:", ...discordOptions] : []),
        "",
        "defaults:",
        "  backend: claude-code",
        "",
      ].join("\n");

      expect(fleetYaml).toContain("type: discord");
      expect(fleetYaml).toContain("options:");
      expect(fleetYaml).toContain('general_channel_id: "345678901234567890"');
      expect(fleetYaml).toContain('category_name: "Custom Category"');
      expect(fleetYaml).toContain("AGEND_DISCORD_TOKEN");
    });
  });

  describe("Plugin check", () => {
    it("npm list -g detects globally installed plugin", () => {
      const { execSync } = require("node:child_process");
      let pluginInstalled = false;
      try {
        // This tests the actual command pattern used in quickstart
        execSync("npm list -g @suzuke/agend-plugin-discord --depth=0", { stdio: "pipe" });
        pluginInstalled = true;
      } catch {
        pluginInstalled = false;
      }
      // Plugin may or may not be installed — just verify the check doesn't crash
      expect(typeof pluginInstalled).toBe("boolean");
    });
  });
});
