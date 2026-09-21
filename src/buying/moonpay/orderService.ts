/** Hosted-widget reconciliation. Source contracts: docs/phase-7d5-3/source-matrix.md. */
import { createHash, randomUUID } from "node:crypto";
import { Prisma, type MoonPayOrder, type PrismaClient } from "@prisma/client";
import { parse, isLosslessNumber } from "lossless-json";
import { z } from "zod";
import type { MoonPayConfig } from "./config";
import { signMoonPayUrl } from "./signing";
import { MoonPayCheckoutInputSchema, MoonPayInputError, validateDestination } from "./validation";
import type { OrderStatus } from "../contract";

export type CreateCheckoutInput = z.infer<typeof MoonPayCheckoutInputSchema> & { userId: string };
const statuses: Record<string, OrderStatus> = {
  waitingPayment: "PENDING", pending: "PENDING", waitingAuthorization: "PENDING",
  completed: "COMPLETED", failed: "FAILED", cancelled: "CANCELLED",
};
const text = z.string().min(1).max(512);
const amount = z.preprocess((v) => isLosslessNumber(v) ? v.toString() : v,
  z.string().max(100).regex(/^\d+(?:\.\d+)?(?:[eE][+-]?\d{1,2})?$/)
    .refine((v) => new Prisma.Decimal(v).isFinite() && new Prisma.Decimal(v).gte(0))
    .transform((v) => new Prisma.Decimal(v).toFixed()));
export const ProviderTransactionSchema = z.object({
  id: text, externalTransactionId: text,
  updatedAt: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  status: text,
  walletAddress: text,
  currency: z.object({ code: text, metadata: z.object({ networkCode: text, chainId: z.string().nullable().optional() }) }),
  baseCurrency: z.object({ code: text }),
  baseCurrencyAmount: amount,
  quoteCurrencyAmount: amount.nullable().optional(),
  cryptoTransactionId: text.nullable().optional(),
  failureReason: z.string().max(1000).nullable().optional(),
});
type ProviderTransaction = z.infer<typeof ProviderTransactionSchema>;
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const codeOf = (e: unknown) => (e as { code?: string })?.code;

export class MoonPayOrderService {
  constructor(private readonly db: PrismaClient, private readonly config: MoonPayConfig) {}

  async createCheckout(input: CreateCheckoutInput) {
    const { userId, ...request } = input;
    const parsed = MoonPayCheckoutInputSchema.safeParse(request);
    if (!parsed.success) throw new MoonPayInputError("Invalid checkout request.");
    validateDestination(input.currencyCode, input.network, input.walletAddress, this.config.environment);
    const data = {
      ...parsed.data, userId, environment: this.config.environment,
      baseCurrencyAmount: new Prisma.Decimal(input.baseCurrencyAmount).toFixed(),
      walletAddress: input.currencyCode === "eth" ? input.walletAddress.toLowerCase() : input.walletAddress,
      redirectUrl: input.redirectUrl ?? null,
    };
    const where = { userId_environment_idempotencyKey: { userId, environment: data.environment, idempotencyKey: input.idempotencyKey } };
    let order = await this.db.moonPayOrder.findUnique({ where });
    let reused = Boolean(order);
    if (!order) {
      try {
        order = await this.db.moonPayOrder.create({ data: { ...data, externalTransactionId: randomUUID(), status: "PENDING" } });
      } catch (err) {
        if (codeOf(err) !== "P2002") throw err;
        order = await this.db.moonPayOrder.findUnique({ where });
        if (!order) throw err;
        reused = true;
      }
    }
    for (const field of ["baseCurrencyCode", "baseCurrencyAmount", "currencyCode", "walletAddress", "network", "redirectUrl"] as const) {
      if (order[field] !== data[field]) throw new MoonPayInputError("Idempotency key belongs to a different checkout.");
    }
    const url = new URL(this.config.widgetBaseUrl);
    for (const [k, v] of Object.entries({ apiKey: this.config.publishableKey, baseCurrencyCode: order.baseCurrencyCode,
      baseCurrencyAmount: order.baseCurrencyAmount, currencyCode: order.currencyCode, walletAddress: order.walletAddress,
      externalTransactionId: order.externalTransactionId, lockAmount: "true", ...(order.redirectUrl ? { redirectURL: order.redirectUrl } : {}) })) {
      url.searchParams.set(k, v);
    }
    return {
      orderId: order.id, externalTransactionId: order.externalTransactionId,
      // Once MoonPay has created a transaction, don't offer a fresh payment link for it.
      url: order.status === "PENDING" && !order.providerTransactionId ? signMoonPayUrl(url.toString(), this.config.secretKey) : undefined,
      environment: order.environment, reused, sandbox: order.environment === "sandbox",
      sandboxNotice: order.environment === "sandbox" ? "Sandbox: testnet assets only; identity checks are not real verification." : null,
    };
  }

  async applyWebhook(rawBody: string, signatureTimestamp: number) {
    if (!Number.isSafeInteger(signatureTimestamp) || signatureTimestamp <= 0) return { applied: false, reason: "invalid timestamp" };
    let envelope: unknown;
    try { envelope = parse(rawBody); } catch { return { applied: false, reason: "payload is not JSON" }; }
    const result = z.object({ type: z.enum(["transaction_created", "transaction_updated", "transaction_failed"]), data: ProviderTransactionSchema }).safeParse(envelope);
    if (!result.success) return { applied: false, reason: "malformed or unsupported event" };
    return this.applyTransaction(result.data.data, digest(rawBody), signatureTimestamp, result.data.type);
  }

  private async applyTransaction(data: ProviderTransaction, payloadHash: string, signatureTimestamp: number, eventType: string) {
    const semanticHash = digest(JSON.stringify([this.config.environment, data.id, data.externalTransactionId, data.updatedAt.toISOString(),
      data.status, data.walletAddress, data.currency.code, data.currency.metadata.networkCode, data.baseCurrency.code,
      data.baseCurrencyAmount, data.quoteCurrencyAmount ?? null, data.cryptoTransactionId ?? null, data.failureReason ?? null]));
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.db.$transaction(async (tx) => {
          // Row lock serializes different events for the same order before reading status.
          await tx.$queryRaw`SELECT id FROM "MoonPayOrder" WHERE "externalTransactionId" = ${data.externalTransactionId} FOR UPDATE`;
          const order = await tx.moonPayOrder.findUnique({ where: { externalTransactionId: data.externalTransactionId } });
          if (!order) return { applied: false, reason: "unknown checkout" };
          const mismatch = describeMismatch(order, data, this.config.environment);
          if (mismatch) return { applied: false, reason: mismatch };
          const status = statuses[data.status];
          if (!status) return { applied: false, reason: "unrecognised provider status" };
          await tx.moonPayWebhookEvent.create({ data: { payloadHash, semanticHash, signatureTimestamp: BigInt(signatureTimestamp), eventType, providerTransactionId: data.id } });
          if (order.providerUpdatedAt && data.updatedAt < order.providerUpdatedAt) return { applied: false, reason: "stale provider event" };
          // A failure is not documented as a chargeback. Completion never regresses.
          if (["COMPLETED", "FAILED", "CANCELLED"].includes(order.status) && order.status !== status) return { applied: false, reason: "terminal order cannot regress" };
          if (order.providerUpdatedAt && +data.updatedAt === +order.providerUpdatedAt && order.status !== status) return { applied: false, reason: "conflicting event at same provider timestamp" };
          if (order.cryptoTransactionId && data.cryptoTransactionId && order.cryptoTransactionId !== data.cryptoTransactionId) return { applied: false, reason: "conflicting delivery reference" };
          await tx.moonPayOrder.update({ where: { id: order.id }, data: {
            providerTransactionId: data.id, status, providerUpdatedAt: data.updatedAt,
            cryptoTransactionId: data.cryptoTransactionId ?? order.cryptoTransactionId,
            quotedAmount: data.quoteCurrencyAmount ?? order.quotedAmount,
            // Never call a quote an observed transfer amount, especially in sandbox.
            failureReason: data.failureReason ?? order.failureReason, reconciliationError: null,
          } });
          return { applied: true, reason: `status -> ${status}` };
        });
      } catch (err) {
        if (codeOf(err) === "P2002") {
          const duplicate = await this.db.moonPayWebhookEvent.findFirst({ where: { OR: [{ payloadHash }, { semanticHash }] } });
          if (duplicate) return { applied: false, reason: "duplicate provider event" };
          return { applied: false, reason: "provider identity already bound to another checkout" };
        }
        if (codeOf(err) === "P2034" && attempt < 2) continue;
        throw err;
      }
    }
  }

  /** Secret-authenticated Widget API, not the public single-transaction endpoint. */
  async reconcile(order: MoonPayOrder, fetcher: typeof fetch = fetch): Promise<void> {
    if (order.environment !== this.config.environment) return;
    const claimed = await this.db.moonPayOrder.updateMany({ where: { id: order.id, OR: [{ lastReconciledAt: null }, { lastReconciledAt: { lt: new Date(Date.now() - 60_000) } }] }, data: { lastReconciledAt: new Date() } });
    if (!claimed.count) return;
    let failure: string | null = null;
    try {
      const url = new URL("https://api.moonpay.com/v1/transactions");
      url.searchParams.set("externalTransactionId", order.externalTransactionId);
      url.searchParams.set("limit", "2");
      const response = await fetcher(url, { headers: { Authorization: `Api-Key ${this.config.secretKey}` }, signal: AbortSignal.timeout(8_000), redirect: "error" });
      if (!response.ok) throw new Error(`Provider lookup unavailable (HTTP ${response.status}).`);
      const raw = await response.text();
      if (raw.length > 262144) throw new Error("Provider response exceeds limit.");
      const items = parse(raw);
      if (!Array.isArray(items)) throw new Error("Malformed provider lookup.");
      if (items.length > 1) throw new Error("Multiple provider transactions match this checkout; review with MoonPay.");
      if (items.length === 1) {
        const parsed = ProviderTransactionSchema.safeParse(items[0]);
        if (!parsed.success || parsed.data.externalTransactionId !== order.externalTransactionId) throw new Error("Provider lookup identity could not be verified.");
        const result = await this.applyTransaction(parsed.data, digest(raw), Math.floor(Date.now() / 1000), "api_reconciliation");
        if (!result.applied && !["duplicate provider event", "stale provider event", "terminal order cannot regress"].includes(result.reason)) failure = "Provider response conflicts with this checkout; review with MoonPay.";
      } else if (Date.now() - order.createdAt.getTime() > 15 * 60_000) {
        failure = "No provider transaction found yet. Check MoonPay before starting another purchase.";
      }
    } catch (err) {
      // Fetch errors can contain URLs or credentials. Persist only our fixed messages/status.
      failure = err instanceof Error && /^(Provider |Malformed provider|Multiple provider|No provider)/.test(err.message) ? err.message : "Provider lookup unavailable; retrying.";
    }
    await this.db.moonPayOrder.update({ where: { id: order.id }, data: { reconciliationError: failure } });
  }
}

export function toOrderStatus(order: { status: string; cryptoTransactionId: string | null; reconciliationError?: string | null }): OrderStatus {
  if (order.status === "COMPLETED") return order.cryptoTransactionId ? "COMPLETED" : "SUBMITTED";
  if (["FAILED", "CANCELLED"].includes(order.status)) return order.status as OrderStatus;
  if (order.reconciliationError) return "UNCERTAIN";
  return (Object.values(statuses).includes(order.status as OrderStatus) ? order.status : "UNCERTAIN") as OrderStatus;
}

export function describeMismatch(order: MoonPayOrder, data: ProviderTransaction, environment: MoonPayConfig["environment"]): string | null {
  if (order.environment !== environment) return "environment mismatch";
  if (order.providerTransactionId && order.providerTransactionId !== data.id) return "provider transaction mismatch";
  try { validateDestination(order.currencyCode, order.network, order.walletAddress, environment); } catch { return "unsupported stored destination"; }
  if (data.currency.code !== order.currencyCode) return "asset mismatch";
  const providerNetwork = order.currencyCode === "eth" ? "ethereum" : "solana";
  if (data.currency.metadata.networkCode !== providerNetwork) return "network mismatch";
  const chainId = data.currency.metadata.chainId;
  if (chainId && (order.currencyCode !== "eth" || !["1", ...(environment === "sandbox" ? ["11155111"] : [])].includes(chainId))) return "chain mismatch";
  const wallet = order.currencyCode === "eth" ? data.walletAddress.toLowerCase() : data.walletAddress;
  const stored = order.currencyCode === "eth" ? order.walletAddress.toLowerCase() : order.walletAddress;
  if (wallet !== stored) return "destination mismatch";
  if (data.baseCurrency.code !== order.baseCurrencyCode || !new Prisma.Decimal(data.baseCurrencyAmount).eq(order.baseCurrencyAmount)) return "fiat amount or currency mismatch";
  return null;
}
