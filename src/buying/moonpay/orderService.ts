/**
 * Phase 7D.5.1 — MoonPay order creation and reconciliation.
 *
 * The rule the whole file is shaped around: **a purchase is complete only when the provider
 * says it settled AND the asset was delivered.** A browser returning from the hosted
 * checkout proves nothing — the user may have closed the tab, the payment may still be
 * pending review, and delivery happens minutes later. So the only thing that advances state
 * is a signature-verified webhook, reconciled server-side.
 *
 * The four states the brief asks to keep apart, and where each lives:
 *   1. our business verification / production activation → `MoonPayConfig.environment`
 *   2. the customer's MoonPay identity verification → MoonPay's, never mirrored as a badge
 *   3. payment/order status → `MoonPayOrder.status`
 *   4. on-chain delivery → `cryptoTransactionId` / `deliveredAmount`
 */

import { createHash, randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import type { MoonPayConfig } from "./config";
import { signMoonPayUrl } from "./signing";
import type { OrderStatus } from "../contract";

/**
 * MoonPay's transaction statuses, mapped to ours.
 *
 * `completed` here means **MoonPay completed the transaction**, which is payment *and*
 * their transfer. It is still not rendered as a finished purchase until a delivery
 * reference exists — see `toOrderStatus`.
 */
const PROVIDER_STATUS: Record<string, OrderStatus> = {
  waitingPayment: "PENDING",
  pending: "PENDING",
  waitingAuthorization: "PENDING",
  waitingCapture: "PENDING",
  completed: "COMPLETED",
  failed: "FAILED",
  cancelled: "CANCELLED",
};

export interface CreateCheckoutInput {
  readonly userId: string;
  /** Fiat the user pays, e.g. "usd". */
  readonly baseCurrencyCode: string;
  readonly baseCurrencyAmount: string;
  /** MoonPay currency code for the asset, e.g. "eth" or "sol". */
  readonly currencyCode: string;
  /** Destination. Signed into the URL so it cannot be tampered with. */
  readonly walletAddress: string;
  /** Our own label for the destination network, for display and for keeping funds apart. */
  readonly network: string;
  readonly redirectUrl?: string;
}

export interface CheckoutSession {
  readonly orderId: string;
  readonly externalTransactionId: string;
  readonly url: string;
  readonly environment: string;
  /** Said plainly so no caller can present a sandbox run as a real purchase. */
  readonly sandboxNotice: string | null;
}

export class MoonPayOrderService {
  constructor(
    private readonly db: PrismaClient,
    private readonly config: MoonPayConfig
  ) {}

  /**
   * Create an order and the signed hosted-checkout URL.
   *
   * The order row exists *before* the user is sent anywhere, so a webhook that arrives
   * while they are still on MoonPay's page has something to attach to.
   */
  async createCheckout(input: CreateCheckoutInput): Promise<CheckoutSession> {
    const externalTransactionId = randomUUID();

    const order = await this.db.moonPayOrder.create({
      data: {
        userId: input.userId,
        externalTransactionId,
        environment: this.config.environment,
        status: "PENDING",
        baseCurrencyCode: input.baseCurrencyCode,
        baseCurrencyAmount: input.baseCurrencyAmount,
        currencyCode: input.currencyCode,
        walletAddress: input.walletAddress,
        network: input.network,
      },
    });

    const url = new URL(this.config.widgetBaseUrl);
    url.searchParams.set("apiKey", this.config.publishableKey);
    url.searchParams.set("baseCurrencyCode", input.baseCurrencyCode);
    url.searchParams.set("baseCurrencyAmount", input.baseCurrencyAmount);
    url.searchParams.set("currencyCode", input.currencyCode);
    url.searchParams.set("walletAddress", input.walletAddress);
    // Ties MoonPay's events back to this row and this user.
    url.searchParams.set("externalTransactionId", externalTransactionId);
    if (input.redirectUrl) url.searchParams.set("redirectURL", input.redirectUrl);

    return {
      orderId: order.id,
      externalTransactionId,
      // Signing is mandatory whenever walletAddress is set; the delivery address is the one
      // parameter that must not be tamperable.
      url: signMoonPayUrl(url.toString(), this.config.secretKey),
      environment: this.config.environment,
      sandboxNotice:
        this.config.environment === "sandbox"
          ? "Sandbox: no real money moves, no real asset is delivered, and identity checks here are not real verification."
          : null,
    };
  }

  /**
   * Apply a verified webhook, exactly once.
   *
   * Idempotency is by payload hash because MoonPay sends no event id. Recording the event
   * first, in the same transaction as the update, means a redelivery is a no-op rather than
   * a second state change — and a crash between the two cannot apply an event twice.
   */
  async applyWebhook(rawBody: string, signatureTimestamp: number): Promise<{ applied: boolean; reason: string }> {
    const payloadHash = createHash("sha256").update(rawBody).digest("hex");

    let payload: { type?: string; data?: Record<string, unknown> };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { applied: false, reason: "payload is not JSON" };
    }
    const data = payload.data ?? {};
    const providerTransactionId = typeof data.id === "string" ? data.id : null;
    const externalTransactionId = typeof data.externalTransactionId === "string" ? data.externalTransactionId : null;

    try {
      return await this.db.$transaction(async (tx) => {
        await tx.moonPayWebhookEvent.create({
          data: {
            signatureTimestamp: BigInt(signatureTimestamp),
            payloadHash,
            eventType: payload.type ?? "unknown",
            providerTransactionId,
          },
        });

        if (!externalTransactionId) {
          // Recorded, not applied: an event we cannot attribute must not touch any order.
          return { applied: false, reason: "event carries no externalTransactionId" };
        }
        const order = await tx.moonPayOrder.findUnique({ where: { externalTransactionId } });
        if (!order) return { applied: false, reason: "no order matches this externalTransactionId" };

        const providerStatus = typeof data.status === "string" ? data.status : "";
        const mapped = PROVIDER_STATUS[providerStatus];
        if (!mapped) return { applied: false, reason: `unrecognised provider status ${JSON.stringify(providerStatus)}` };

        await tx.moonPayOrder.update({
          where: { id: order.id },
          data: {
            providerTransactionId: providerTransactionId ?? order.providerTransactionId,
            status: mapped,
            cryptoTransactionId: typeof data.cryptoTransactionId === "string" ? data.cryptoTransactionId : order.cryptoTransactionId,
            deliveredAmount: typeof data.quoteCurrencyAmount === "number" ? String(data.quoteCurrencyAmount) : order.deliveredAmount,
            failureReason: typeof data.failureReason === "string" ? data.failureReason : order.failureReason,
          },
        });
        return { applied: true, reason: `status -> ${mapped}` };
      });
    } catch (err) {
      // The unique index on payloadHash is the idempotency guard.
      if (isUniqueViolation(err)) return { applied: false, reason: "duplicate webhook, already applied" };
      throw err;
    }
  }
}

/**
 * What the UI should show.
 *
 * Payment settling is not delivery. An order MoonPay calls `completed` with no delivery
 * reference is reported as `SUBMITTED`, never `COMPLETED` — the asset has not arrived, and
 * saying it has is the exact mistake the brief forbids.
 */
export function toOrderStatus(order: { status: string; cryptoTransactionId: string | null }): OrderStatus {
  if (order.status === "COMPLETED" && !order.cryptoTransactionId) return "SUBMITTED";
  return (order.status as OrderStatus) ?? "PENDING";
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}
