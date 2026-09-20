import { describe, expect, it, vi } from "vitest";

import { MoonPayOrderService, toOrderStatus } from "../moonpay/orderService";
import { moonPayUrlSignature } from "../moonpay/signing";
import type { MoonPayConfig } from "../moonpay/config";

/**
 * Phase 7D.5.1 — a purchase is complete only when the provider settled AND the asset
 * arrived. Everything here defends that line.
 */

const config: MoonPayConfig = {
  environment: "sandbox",
  secretKey: "sk_test_abcdefghijklmnopqrstuvwxyz01",
  publishableKey: "pk_test_abcdefghijklmnopqrstuvwxyz01",
  webhookSecret: "wk_test_abcdefghijklmnopqrstuvwxyz01",
  widgetBaseUrl: "https://buy-sandbox.moonpay.com",
};

function db(over: { order?: Record<string, unknown> | null; createEventThrows?: unknown } = {}) {
  const created: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const tx = {
    moonPayWebhookEvent: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        if (over.createEventThrows) throw over.createEventThrows;
        created.push(args.data);
        return args.data;
      }),
    },
    moonPayOrder: {
      findUnique: vi.fn(async () => over.order ?? null),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return args.data;
      }),
    },
  };
  return {
    updates,
    created,
    tx,
    client: {
      moonPayOrder: { create: vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: "order-1", ...args.data })) },
      $transaction: vi.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    },
  };
}

const ORDER = { id: "order-1", externalTransactionId: "ext-1", providerTransactionId: null, cryptoTransactionId: null, deliveredAmount: null, failureReason: null };

describe("checkout creation", () => {
  it("creates the order before sending the user anywhere", async () => {
    // A webhook can arrive while the user is still on MoonPay's page; it needs a row to attach to.
    const d = db();
    const service = new MoonPayOrderService(d.client as never, config);
    const session = await service.createCheckout({
      userId: "user-1",
      baseCurrencyCode: "usd",
      baseCurrencyAmount: "50",
      currencyCode: "eth",
      walletAddress: "0xabc",
      network: "ethereum-sepolia",
    });
    expect(d.client.moonPayOrder.create).toHaveBeenCalled();
    expect(session.orderId).toBe("order-1");
  });

  it("signs the URL and carries only the publishable key", async () => {
    const service = new MoonPayOrderService(db().client as never, config);
    const { url } = await service.createCheckout({
      userId: "u", baseCurrencyCode: "usd", baseCurrencyAmount: "50", currencyCode: "eth", walletAddress: "0xabc", network: "ethereum-sepolia",
    });
    const parsed = new URL(url);
    expect(parsed.origin).toBe("https://buy-sandbox.moonpay.com");
    expect(parsed.searchParams.get("apiKey")).toBe(config.publishableKey);
    // The secret must never appear in something handed to a browser.
    expect(url).not.toContain(config.secretKey);
    expect(url).not.toContain(config.webhookSecret);

    const unsigned = url.slice(0, url.indexOf("&signature="));
    expect(parsed.searchParams.get("signature")).toBe(moonPayUrlSignature(unsigned, config.secretKey));
  });

  it("ties the checkout to our own id so events map back to a user", async () => {
    const service = new MoonPayOrderService(db().client as never, config);
    const session = await service.createCheckout({
      userId: "u", baseCurrencyCode: "usd", baseCurrencyAmount: "50", currencyCode: "sol", walletAddress: "Sol1", network: "solana-devnet",
    });
    expect(new URL(session.url).searchParams.get("externalTransactionId")).toBe(session.externalTransactionId);
  });

  it("labels sandbox explicitly, including that KYC there is not real verification", async () => {
    const service = new MoonPayOrderService(db().client as never, config);
    const session = await service.createCheckout({
      userId: "u", baseCurrencyCode: "usd", baseCurrencyAmount: "50", currencyCode: "eth", walletAddress: "0xabc", network: "ethereum-sepolia",
    });
    expect(session.environment).toBe("sandbox");
    expect(session.sandboxNotice).toMatch(/not real verification/i);
  });
});

describe("webhook reconciliation", () => {
  const body = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "transaction_updated", data: { id: "tx_1", externalTransactionId: "ext-1", status: "completed", ...over } });

  it("applies a recognised status", async () => {
    const d = db({ order: ORDER });
    const result = await new MoonPayOrderService(d.client as never, config).applyWebhook(body(), 1_700_000_000);
    expect(result.applied).toBe(true);
    expect(d.updates[0]).toMatchObject({ status: "COMPLETED", providerTransactionId: "tx_1" });
  });

  it("records the event before applying it, in the same transaction", async () => {
    const d = db({ order: ORDER });
    await new MoonPayOrderService(d.client as never, config).applyWebhook(body(), 1_700_000_000);
    // A crash between the two would otherwise let the same event apply twice.
    expect(d.tx.moonPayWebhookEvent.create.mock.invocationCallOrder[0]).toBeLessThan(
      d.tx.moonPayOrder.update.mock.invocationCallOrder[0]
    );
  });

  it("treats a redelivered webhook as a no-op, not a second state change", async () => {
    const duplicate = Object.assign(new Error("unique"), { code: "P2002" });
    const d = db({ order: ORDER, createEventThrows: duplicate });
    const result = await new MoonPayOrderService(d.client as never, config).applyWebhook(body(), 1_700_000_000);
    expect(result).toMatchObject({ applied: false, reason: "duplicate webhook, already applied" });
    expect(d.tx.moonPayOrder.update).not.toHaveBeenCalled();
  });

  it("records but does not apply an event it cannot attribute", async () => {
    const d = db({ order: ORDER });
    const result = await new MoonPayOrderService(d.client as never, config).applyWebhook(
      JSON.stringify({ type: "transaction_updated", data: { id: "tx_1", status: "completed" } }),
      1_700_000_000
    );
    expect(result.applied).toBe(false);
    expect(d.tx.moonPayOrder.update).not.toHaveBeenCalled();
    expect(d.created).toHaveLength(1);
  });

  it("refuses an unrecognised provider status rather than guessing", async () => {
    const d = db({ order: ORDER });
    const result = await new MoonPayOrderService(d.client as never, config).applyWebhook(body({ status: "somethingNew" }), 1_700_000_000);
    expect(result.applied).toBe(false);
    expect(result.reason).toMatch(/unrecognised provider status/);
  });

  it("maps failure and cancellation distinctly", async () => {
    for (const [provider, expected] of [["failed", "FAILED"], ["cancelled", "CANCELLED"], ["waitingPayment", "PENDING"]] as const) {
      const d = db({ order: ORDER });
      await new MoonPayOrderService(d.client as never, config).applyWebhook(body({ status: provider }), 1_700_000_000);
      expect(d.updates[0]).toMatchObject({ status: expected });
    }
  });

  it("records delivery separately from payment", async () => {
    const d = db({ order: ORDER });
    await new MoonPayOrderService(d.client as never, config).applyWebhook(
      body({ cryptoTransactionId: "0xdeadbeef", quoteCurrencyAmount: 0.001 }),
      1_700_000_000
    );
    expect(d.updates[0]).toMatchObject({ cryptoTransactionId: "0xdeadbeef", deliveredAmount: "0.001" });
  });

  it("rejects a non-JSON payload", async () => {
    const d = db({ order: ORDER });
    expect(await new MoonPayOrderService(d.client as never, config).applyWebhook("not json", 1)).toMatchObject({ applied: false });
  });
});

describe("what the UI is allowed to call complete", () => {
  it("does not call a paid-but-undelivered order complete", () => {
    // MoonPay settling the payment is not the asset arriving.
    expect(toOrderStatus({ status: "COMPLETED", cryptoTransactionId: null })).toBe("SUBMITTED");
  });

  it("calls it complete once delivery is referenced", () => {
    expect(toOrderStatus({ status: "COMPLETED", cryptoTransactionId: "0xabc" })).toBe("COMPLETED");
  });

  it("passes other statuses through", () => {
    expect(toOrderStatus({ status: "FAILED", cryptoTransactionId: null })).toBe("FAILED");
    expect(toOrderStatus({ status: "PENDING", cryptoTransactionId: null })).toBe("PENDING");
  });
});
