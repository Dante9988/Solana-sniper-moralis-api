import { afterEach, describe, expect, it } from "vitest";
import { getTelegramAdminIds, isTelegramAdmin } from "../adminGuard";

describe("telegram adminGuard: fails closed", () => {
  const original = process.env.TELEGRAM_ADMIN_IDS;
  afterEach(() => {
    if (original === undefined) delete process.env.TELEGRAM_ADMIN_IDS;
    else process.env.TELEGRAM_ADMIN_IDS = original;
  });

  it("denies everyone when TELEGRAM_ADMIN_IDS is unset", () => {
    delete process.env.TELEGRAM_ADMIN_IDS;
    expect(isTelegramAdmin("12345")).toBe(false);
  });

  it("denies everyone when TELEGRAM_ADMIN_IDS is an empty string", () => {
    process.env.TELEGRAM_ADMIN_IDS = "";
    expect(isTelegramAdmin("12345")).toBe(false);
  });

  it("denies an unlisted user id", () => {
    process.env.TELEGRAM_ADMIN_IDS = "111,222";
    expect(isTelegramAdmin("333")).toBe(false);
  });

  it("allows a listed user id, trimming whitespace around entries", () => {
    process.env.TELEGRAM_ADMIN_IDS = "111, 222 ,333";
    expect(isTelegramAdmin("222")).toBe(true);
    expect(getTelegramAdminIds()).toEqual(["111", "222", "333"]);
  });

  it("denies when no user id is available", () => {
    process.env.TELEGRAM_ADMIN_IDS = "111";
    expect(isTelegramAdmin(undefined)).toBe(false);
  });
});
