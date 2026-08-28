import { afterEach, describe, expect, it } from "vitest";
import { getDiscordAdminIds, isDiscordAdmin } from "../adminGuard";

describe("discord adminGuard: fails closed", () => {
  const original = process.env.DISCORD_ADMIN_IDS;
  afterEach(() => {
    if (original === undefined) delete process.env.DISCORD_ADMIN_IDS;
    else process.env.DISCORD_ADMIN_IDS = original;
  });

  it("denies everyone when DISCORD_ADMIN_IDS is unset", () => {
    delete process.env.DISCORD_ADMIN_IDS;
    expect(isDiscordAdmin("12345")).toBe(false);
  });

  it("denies an unlisted user id", () => {
    process.env.DISCORD_ADMIN_IDS = "111,222";
    expect(isDiscordAdmin("333")).toBe(false);
  });

  it("allows a listed user id, trimming whitespace around entries", () => {
    process.env.DISCORD_ADMIN_IDS = "111, 222 ,333";
    expect(isDiscordAdmin("222")).toBe(true);
    expect(getDiscordAdminIds()).toEqual(["111", "222", "333"]);
  });

  it("denies when no user id is available", () => {
    process.env.DISCORD_ADMIN_IDS = "111";
    expect(isDiscordAdmin(undefined)).toBe(false);
  });
});
