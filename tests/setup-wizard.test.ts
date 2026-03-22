import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateBotToken, verifyBotToken, checkPrerequisites } from "../src/setup-wizard.js";

describe("Setup Wizard", () => {
  describe("validateBotToken", () => {
    it("rejects obviously invalid token format", () => {
      expect(validateBotToken("not-a-token")).toBe(false);
      expect(validateBotToken("")).toBe(false);
      expect(validateBotToken("123:short")).toBe(false);
    });

    it("accepts valid token format", () => {
      expect(validateBotToken("123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567")).toBe(true);
      expect(validateBotToken("8643519444:AAGMcAd0TNloFeKeuaYkfVmPoeBuGelmmw8")).toBe(true);
    });
  });

  describe("verifyBotToken", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("verifies token against Telegram API", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: true, result: { username: "test_bot" } }),
      });
      global.fetch = mockFetch;

      const result = await verifyBotToken("123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567");
      expect(result).toEqual({ valid: true, username: "test_bot" });
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.telegram.org/bot123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567/getMe",
      );
    });

    it("returns invalid for rejected token", async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ ok: false, description: "Unauthorized" }),
      });

      const result = await verifyBotToken("000000000:fake_token_that_is_long_enough_here");
      expect(result).toEqual({ valid: false, username: null });
    });

    it("returns invalid on network error", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

      const result = await verifyBotToken("123456789:ABCdefGHIjklMNOpqrSTUvwxYZ_1234567");
      expect(result).toEqual({ valid: false, username: null });
    });
  });

  describe("checkPrerequisites", () => {
    it("returns detection results", () => {
      const result = checkPrerequisites();
      // In test env, claude and tmux may or may not be installed
      expect(result).toHaveProperty("claude");
      expect(result).toHaveProperty("tmux");
      expect(typeof result.claude).toBe("boolean");
      expect(typeof result.tmux).toBe("boolean");
    });
  });
});
