import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "lossless-json";
import { ProviderTransactionSchema, toOrderStatus } from "../moonpay/orderService";
import { validateDestination } from "../moonpay/validation";
const raw = readFileSync("src/buying/__tests__/fixtures/moonpay-completed.json", "utf8");
describe("MoonPay documented wire shape", () => {
  it("preserves quoted decimal precision without claiming delivery amount", () => {
    const parsed = ProviderTransactionSchema.parse((parse(raw) as { data: unknown }).data);
    expect(parsed.quoteCurrencyAmount).toBe("0.012345678901234567");
  });
  it.each(["id", "externalTransactionId", "updatedAt", "currency", "walletAddress", "baseCurrency"])("fails closed without %s", (field) => {
    const data = JSON.parse(raw).data; delete data[field];
    expect(ProviderTransactionSchema.safeParse(data).success).toBe(false);
  });
  it("rejects unknown and mismatched asset/network pairs", () => {
    for (const [asset, network] of [["usdc", "solana-devnet"], ["eth", "robinhood"], ["eth", "ethereum"]]) {
      expect(() => validateDestination(asset, network, "0x1111111111111111111111111111111111111111", "sandbox")).toThrow();
    }
  });
  it("keeps completion, payment and uncertainty distinct", () => {
    expect(toOrderStatus({ status: "COMPLETED", cryptoTransactionId: null })).toBe("SUBMITTED");
    expect(toOrderStatus({ status: "COMPLETED", cryptoTransactionId: "tx" })).toBe("COMPLETED");
    expect(toOrderStatus({ status: "PENDING", cryptoTransactionId: null, reconciliationError: "unavailable" })).toBe("UNCERTAIN");
  });
});
