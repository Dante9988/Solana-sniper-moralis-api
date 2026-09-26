/**
 * Phase 7E.4.3 §11 (pipeline integration) — Pump.fun trade -> the EXISTING candle pipeline.
 *
 * §11: "Do NOT build Solana-specific candle infrastructure." This file is the proof that none was
 * built: it seeds Solana facts through the real persistence path, then runs
 * `runCandleAggregationTick` — the same worker tick Robinhood uses, unmodified — and asserts OHLC,
 * volume, trade count, unique traders, latest price and the absence of duplicate bars.
 *
 * The `chainClient` passed in throws on every method. That is deliberate: it turns "Solana needs no
 * EVM RPC in this path" from a claim into something the test would fail on.
 *
 * Run:
 *   SOLANA_RUN_DB_TESTS=true DATABASE_URL=postgresql://... npx vitest run src/solana/__tests__/pumpfunPipeline.dbIntegration.test.ts
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { runCandleAggregationTick } from "../../candles/candleAggregationService";
import { resetDecimalsResolverMemo } from "../../candles/decimalsResolver";
import type { QuoteUsdRateProvider, QuoteUsdRateResult } from "../../candles/usdPricing";
import { NullQuoteUsdRateProvider } from "../../candles/usdPricing";
import type { ChainReader } from "../../pons/chainClient";
import { quoteRawToUsd } from "../../discovery/quoteUsd";
import { PUMPFUN_CHECKPOINT_SOURCE } from "../pumpfunIngestionEngine";
import { NATIVE_SOL_DECIMALS, NATIVE_SOL_QUOTE_SENTINEL } from "../solanaDecimals";
import { persistPumpfunBatch } from "../pumpfunPersistence";
import { encodeSolanaSourceIndex } from "../pumpfunAdapter";
import type { NormalizedTokenDiscovered, NormalizedTradeExecuted } from "../../discovery/types";

const RUN_DB_TESTS = process.env.SOLANA_RUN_DB_TESTS === "true";

const CHAIN = "solana";
const VENUE = "pumpfun";
/** A real pump.fun mint shape; this test writes only rows it also deletes. */
const MINT = "PipelineTest1111111111111111111111111pump";
const QUOTE = NATIVE_SOL_QUOTE_SENTINEL;
const TOKEN_DECIMALS = 6;
const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Every method throws: if the Solana candle path needs an EVM client, this test says so loudly. */
const forbiddenChainClient = new Proxy({} as ChainReader, {
  get(_target, property) {
    return () => {
      throw new Error(`the Solana candle path must not call the EVM chain client (called ${String(property)})`);
    };
  },
});

/** A fixed, explicitly-dated rate. Injected, never a constant in src/ (§10). */
class FixedRateProvider implements QuoteUsdRateProvider {
  readonly name = "test-fixed-rate";
  constructor(private readonly rateUsdPerQuote: string) {}
  async getHistoricalRate(): Promise<QuoteUsdRateResult> {
    return { status: "AVAILABLE", rate: { rateUsdPerQuote: this.rateUsdPerQuote, observedAt: new Date("2026-01-01T00:00:00.000Z"), source: "test" } };
  }
}

const BASE = new Date("2026-01-01T00:00:00.000Z");

describe.skipIf(!RUN_DB_TESTS)("Pump.fun trades through the existing candle pipeline — real Postgres", () => {
  const prisma = new PrismaClient();

  async function cleanup(): Promise<void> {
    await prisma.marketCandle.deleteMany({ where: { chain: CHAIN, tokenAddress: MINT } });
    await prisma.candleInvalidation.deleteMany({ where: { chain: CHAIN, tokenAddress: MINT } });
    await prisma.candleAggregationCheckpoint.deleteMany({ where: { chain: CHAIN, tokenAddress: MINT } });
    await prisma.candleWorkerRunState.deleteMany({ where: { chain: CHAIN } });
    await prisma.chainTrade.deleteMany({ where: { chain: CHAIN, tokenAddress: MINT } });
    await prisma.discoveredToken.deleteMany({ where: { chain: CHAIN, tokenAddress: MINT } });
    await prisma.pumpLifecycleEvent.deleteMany({ where: { mint: MINT } });
    await prisma.tokenLifecycleState.deleteMany({ where: { mint: MINT } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: PUMPFUN_CHECKPOINT_SOURCE } });
  }

  beforeAll(cleanup);
  beforeEach(async () => {
    await cleanup();
    resetDecimalsResolverMemo();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  function discovered(slot: number): NormalizedTokenDiscovered {
    return {
      kind: "tokenDiscovered",
      chain: CHAIN,
      venue: VENUE,
      tokenAddress: MINT,
      deployer: "DeployerTest11111111111111111111111111111111",
      poolAddress: null,
      quoteAddress: QUOTE,
      supply: "1000000000000000",
      initialBuyAmount: "0",
      provenance: { sourceHeight: String(slot), sourceHash: `blockhash-${slot}`, sourceTxHash: `create-${slot}`, sourceIndex: encodeSolanaSourceIndex(0, 0) },
      observedAt: BASE.toISOString(),
      metadata: { name: "Pipeline", symbol: "PIPE", metadataUri: null, tokenDecimals: TOKEN_DECIMALS, quoteDecimals: NATIVE_SOL_DECIMALS, curveAddress: "CurveTest111111111111111111111111111111111" },
    };
  }

  /** `tokenAmount`/`quoteAmount` are raw base units, exactly as a TradeEvent reports them. */
  function trade(params: { slot: number; index: number; tokenAmount: string; quoteAmount: string; side?: "buy" | "sell"; trader?: string; signature?: string }): NormalizedTradeExecuted {
    return {
      kind: "tradeExecuted",
      chain: CHAIN,
      venue: "pump",
      tokenAddress: MINT,
      poolAddress: null,
      side: params.side ?? "buy",
      tokenAmount: params.tokenAmount,
      quoteAmount: params.quoteAmount,
      quoteAddress: QUOTE,
      priceQuote: "1",
      priceUsd: null,
      trader: params.trader ?? "TraderTestAAAA1111111111111111111111111111",
      provenance: {
        sourceHeight: String(params.slot),
        sourceHash: `blockhash-${params.slot}`,
        sourceTxHash: params.signature ?? `sig-${params.slot}-${params.index}`,
        sourceIndex: encodeSolanaSourceIndex(params.index, 0),
      },
      observedAt: BASE.toISOString(),
    };
  }

  async function seed(trades: NormalizedTradeExecuted[], blockTimeSeconds: number, slot = 100): Promise<void> {
    await persistPumpfunBatch({
      db: prisma,
      batch: { signature: `seed-${slot}`, slot, blockTime: blockTimeSeconds, discovered: [discovered(slot)], trades: [], lifecycle: [], identities: [], unmappedEventNames: [] },
      source: "live stream",
    });
    for (const one of trades) {
      await persistPumpfunBatch({
        db: prisma,
        batch: {
          signature: one.provenance.sourceTxHash,
          slot: Number(one.provenance.sourceHeight),
          blockTime: blockTimeSeconds,
          discovered: [],
          trades: [one],
          lifecycle: [],
          identities: [],
          unmappedEventNames: [],
        },
        source: "live stream",
      });
    }
  }

  async function setFinalityCheckpoint(lastHeightTimestamp: Date | null): Promise<void> {
    await prisma.chainIngestionCheckpoint.upsert({
      where: { source: PUMPFUN_CHECKPOINT_SOURCE },
      create: { source: PUMPFUN_CHECKPOINT_SOURCE, lastHeight: 999_999n, lastHash: "blockhash-head", lastHeightTimestamp },
      update: { lastHeightTimestamp },
    });
  }

  function deps(overrides: Partial<Parameters<typeof runCandleAggregationTick>[0]> = {}) {
    return {
      db: prisma,
      chainClient: forbiddenChainClient,
      chain: CHAIN,
      venue: VENUE,
      usdRateProvider: new NullQuoteUsdRateProvider(),
      maxInvalidationTokensPerTick: 10,
      maxForwardTokensPerTick: 10,
      tradePageCap: 1000,
      logger: noopLogger,
      ...overrides,
    };
  }

  it("builds 1m and 5m candles with correct OHLC, volume and trade count", async () => {
    // Three trades inside one 1-minute bucket. 6-decimal token, 9-decimal native SOL quote.
    // 1.0 token for 0.02 SOL  -> price 0.02
    // 2.0 token for 0.06 SOL  -> price 0.03
    // 1.0 token for 0.01 SOL  -> price 0.01
    await seed(
      [
        trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "20000000" }),
        trade({ slot: 100, index: 1, tokenAmount: "2000000", quoteAmount: "60000000" }),
        trade({ slot: 100, index: 2, tokenAmount: "1000000", quoteAmount: "10000000", side: "sell" }),
      ],
      Math.floor(BASE.getTime() / 1000)
    );

    await runCandleAggregationTick(deps());

    for (const resolution of ["M1", "M5"] as const) {
      const candles = await prisma.marketCandle.findMany({ where: { chain: CHAIN, tokenAddress: MINT, resolution } });
      expect(candles, resolution).toHaveLength(1);
      const candle = candles[0];
      expect(candle.open.toFixed(), resolution).toBe("0.02");
      expect(candle.high.toFixed(), resolution).toBe("0.03");
      expect(candle.low.toFixed(), resolution).toBe("0.01");
      expect(candle.close.toFixed(), resolution).toBe("0.01");
      // 1 + 2 + 1 whole tokens, and 0.02 + 0.06 + 0.01 whole SOL — both decimals-normalized.
      expect(candle.volumeToken.toFixed(), resolution).toBe("4");
      expect(candle.volumeQuote.toFixed(), resolution).toBe("0.09");
      expect(candle.tradeCount, resolution).toBe(3);
      expect(candle.uniqueTraders, resolution).toBe(1);
    }
  });

  it("counts unique traders rather than trades", async () => {
    await seed(
      [
        trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "10000000", trader: "TraderTestAAAA1111111111111111111111111111" }),
        trade({ slot: 100, index: 1, tokenAmount: "1000000", quoteAmount: "10000000", trader: "TraderTestBBBB1111111111111111111111111111" }),
        trade({ slot: 100, index: 2, tokenAmount: "1000000", quoteAmount: "10000000", trader: "TraderTestAAAA1111111111111111111111111111" }),
      ],
      Math.floor(BASE.getTime() / 1000)
    );

    await runCandleAggregationTick(deps());

    const candle = await prisma.marketCandle.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" } });
    expect(candle.tradeCount).toBe(3);
    expect(candle.uniqueTraders).toBe(2);
  });

  it("separates buckets and reports the latest price from the newest bar", async () => {
    const firstBucket = Math.floor(BASE.getTime() / 1000);
    await seed([trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "20000000" })], firstBucket);
    await runCandleAggregationTick(deps());

    // A trade six minutes later must land in its own 1m and 5m buckets.
    await persistPumpfunBatch({
      db: prisma,
      batch: {
        signature: "sig-later",
        slot: 200,
        blockTime: firstBucket + 360,
        discovered: [],
        trades: [trade({ slot: 200, index: 0, tokenAmount: "1000000", quoteAmount: "50000000", signature: "sig-later" })],
        lifecycle: [],
        identities: [],
        unmappedEventNames: [],
      },
      source: "live stream",
    });
    await runCandleAggregationTick(deps());

    const m1 = await prisma.marketCandle.findMany({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" }, orderBy: { bucketStart: "asc" } });
    expect(m1).toHaveLength(2);
    expect(m1[0].close.toFixed()).toBe("0.02");
    expect(m1[1].close.toFixed()).toBe("0.05");

    const m5 = await prisma.marketCandle.findMany({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M5" }, orderBy: { bucketStart: "asc" } });
    expect(m5).toHaveLength(2);
    expect(m5[m5.length - 1].close.toFixed()).toBe("0.05");
  });

  it("does not double-count volume when the same trade is replayed", async () => {
    const at = Math.floor(BASE.getTime() / 1000);
    const one = trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "20000000", signature: "sig-replayed" });
    await seed([one], at);
    // Replay it the way a duplicate WebSocket frame plus a recovery sweep would.
    for (const source of ["live stream", "historical backfill", "block reconciliation"] as const) {
      await persistPumpfunBatch({
        db: prisma,
        batch: { signature: one.provenance.sourceTxHash, slot: 100, blockTime: at, discovered: [], trades: [one], lifecycle: [], identities: [], unmappedEventNames: [] },
        source,
      });
    }

    expect(await prisma.chainTrade.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(1);

    await runCandleAggregationTick(deps());
    await runCandleAggregationTick(deps());

    const candle = await prisma.marketCandle.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" } });
    expect(candle.tradeCount).toBe(1);
    expect(candle.volumeToken.toFixed()).toBe("1");
    expect(candle.volumeQuote.toFixed()).toBe("0.02");
    // And no duplicate bars, from either the repeated trade or the repeated tick.
    expect(await prisma.marketCandle.count({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" } })).toBe(1);
  });

  it("leaves USD volume null when no rate is available, and still produces the candle", async () => {
    await seed([trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "20000000" })], Math.floor(BASE.getTime() / 1000));
    await runCandleAggregationTick(deps());

    const candle = await prisma.marketCandle.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" } });
    // §10: unavailable, never estimated. The quote-denominated candle is fully usable regardless.
    expect(candle.volumeUsd).toBeNull();
    expect(candle.volumeQuote.toFixed()).toBe("0.02");
  });

  it("computes USD volume through the same conversion the trending windows use", async () => {
    const at = Math.floor(BASE.getTime() / 1000);
    // 0.02 SOL and 0.06 SOL of volume, at an explicit $213.47/SOL.
    await seed(
      [
        trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "20000000" }),
        trade({ slot: 100, index: 1, tokenAmount: "2000000", quoteAmount: "60000000" }),
      ],
      at
    );

    await runCandleAggregationTick(deps({ usdRateProvider: new FixedRateProvider("213.47") }));

    const candle = await prisma.marketCandle.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" } });
    // Derived here with the very same function the pipeline used, from the raw amounts and the
    // verified 9 native-SOL decimals — not from a number typed into this test.
    const perTrade = ["20000000", "60000000"].map((raw) => quoteRawToUsd(raw, NATIVE_SOL_DECIMALS, "213.47")!);
    const total = perTrade.reduce((sum, value) => sum + Number(value), 0);
    expect(Number(candle.volumeUsd!.toFixed())).toBeCloseTo(total, 6);
    // Sanity: ~$17.08, i.e. 0.08 SOL. A skipped decimals step would report ~$17 billion.
    expect(Number(candle.volumeUsd!.toFixed())).toBeGreaterThan(17);
    expect(Number(candle.volumeUsd!.toFixed())).toBeLessThan(18);
  });

  it("finalizes a bucket only once finalized ingestion has passed its end", async () => {
    const at = Math.floor(BASE.getTime() / 1000);
    await seed([trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "20000000" })], at);

    // No finalized progress recorded yet: provisional, however much wall-clock time has passed.
    await setFinalityCheckpoint(null);
    await runCandleAggregationTick(deps());
    expect((await prisma.marketCandle.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" } })).status).toBe("PROVISIONAL");

    // Finalized ingestion now past the bucket's end.
    await setFinalityCheckpoint(new Date((at + 120) * 1000));
    await runCandleAggregationTick(deps());
    expect((await prisma.marketCandle.findFirstOrThrow({ where: { chain: CHAIN, tokenAddress: MINT, resolution: "M1" } })).status).toBe("FINAL");
  });

  it("skips a token whose decimals were never resolved, instead of guessing", async () => {
    // The row is written with null decimals, as a failed mint read leaves it.
    await persistPumpfunBatch({
      db: prisma,
      batch: {
        signature: "seed-nodec",
        slot: 100,
        blockTime: Math.floor(BASE.getTime() / 1000),
        discovered: [{ ...discovered(100), metadata: { name: null, symbol: null, metadataUri: null, tokenDecimals: null, quoteDecimals: null, curveAddress: null } }],
        trades: [],
        lifecycle: [],
        identities: [],
        unmappedEventNames: [],
      },
      source: "live stream",
    });
    await persistPumpfunBatch({
      db: prisma,
      batch: {
        signature: "sig-nodec",
        slot: 100,
        blockTime: Math.floor(BASE.getTime() / 1000),
        discovered: [],
        trades: [trade({ slot: 100, index: 0, tokenAmount: "1000000", quoteAmount: "20000000", signature: "sig-nodec" })],
        lifecycle: [],
        identities: [],
        unmappedEventNames: [],
      },
      source: "live stream",
    });

    // Must not throw — in particular must not reach for the EVM client, which would throw loudly.
    await runCandleAggregationTick(deps());
    expect(await prisma.marketCandle.count({ where: { chain: CHAIN, tokenAddress: MINT } })).toBe(0);
  });
});
