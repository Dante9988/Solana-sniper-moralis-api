/**
 * Phase 7D.4 — keeps `TokenMarketSnapshot` current for every canonical Pons V2 token.
 *
 * Each batch is one Multicall3 `aggregate3` at one pinned block, so every value in a snapshot is
 * from the same chain state. Tokens are scheduled individually (`nextRefreshAt`): active tokens
 * every minute or two, unchanged ones backing off to six hours. USD values use the verified
 * Chainlink provider at the pinned block's time and stay null when no verified rate exists.
 *
 * A token the database lists as bonding that the curve reports graduated is not guessed at: it
 * is recorded FAILED ("graduated on chain; pool not indexed yet") until discovery records its pool.
 */

import type { Prisma, PrismaClient } from "@prisma/client";
import { parseAbi } from "viem";

import type { QuoteUsdRateProvider } from "../../candles/usdPricing";
import type { ChainCaller } from "../chainClient";
import { multicallAt, snapshotAt, type ContractRead, type ReadResult } from "../quote/pinnedReads";
import { PONS_V2_FACTORY_ABI } from "../abiV2";
import { PONS_MEME_HOOK_ABI, PONS_V2_PHASE, STATE_VIEW_ABI, UNISWAP_V4_ROBINHOOD } from "../quote/protocol";
import { buildPoolKey, poolIdFor } from "../v4PoolState";
import { lookupQuoteAsset } from "../usd/chainlinkQuoteUsdRateProvider";
import { curveSnapshot, nextRefreshDelayMs, poolSnapshot, toUsd, type QuoteDenominatedSnapshot } from "./marketSnapshot";

export const SNAPSHOT_CURVE_ABI = parseAbi([
  "function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)",
  "function realQuoteReserve() view returns (uint256)",
  "function reservedTokens() view returns (uint256)",
  "function launchSupply() view returns (uint256)",
  "function sellableTokens() view returns (uint256)",
  "function graduated() view returns (bool)",
  "function readyToGraduate() view returns (bool)",
  "function graduationThreshold() view returns (uint256)",
]);
const ERC20_SUPPLY_ABI = parseAbi(["function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)"]);
const NATIVE = "0x0000000000000000000000000000000000000000";
const CURVE_FNS = ["getReserves", "realQuoteReserve", "reservedTokens", "launchSupply", "sellableTokens", "graduated", "readyToGraduate", "graduationThreshold"] as const;

export interface DueToken {
  tokenAddress: string;
  curveAddress: string | null;
  poolId: string | null;
  isToken0: boolean | null;
  graduated: boolean;
  quoteAddress: string;
  unchangedReads: number;
  prevPrice: string | null;
  prevLiquidity: string | null;
}

export interface SnapshotWorkerOptions {
  db: PrismaClient;
  caller: ChainCaller;
  usd: QuoteUsdRateProvider;
  now?: () => Date;
  /** Pons V2 factory; lets a token that graduated after discovery's height be priced from its pool. */
  factoryAddress?: string;
  batchTokens?: number;
  tokensPerMulticall?: number;
  log?: (msg: string) => void;
}

type Plan = { token: DueToken; kind: "curve" | "pool"; start: number; count: number; quoteDecimalsIndex: number | null };

function ok<T>(r: ReadResult | undefined): T {
  if (!r || !r.ok) throw new Error("read reverted");
  return r.value as T;
}

/** Creates PENDING rows for canonical tokens that have none yet. Returns how many were added. */
export async function seedSnapshots(db: PrismaClient, limit = 5_000): Promise<number> {
  return db.$executeRaw`
    INSERT INTO "TokenMarketSnapshot" ("id", "chain", "tokenAddress", "status", "updatedAt")
    SELECT gen_random_uuid()::text, 'robinhood', lower(d."tokenAddress"), 'PENDING', now()
    FROM "DiscoveredToken" d
    WHERE d.chain = 'robinhood' AND d.venue = 'pons_v2' AND d."canonicalStatus" = 'CANONICAL' AND d."curveAddress" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "TokenMarketSnapshot" s WHERE s.chain = 'robinhood' AND s."tokenAddress" = d."tokenAddress")
    ORDER BY d."sourceHeight" DESC
    LIMIT ${limit}
    ON CONFLICT DO NOTHING`;
}

export async function selectDueTokens(db: PrismaClient, now: Date, limit: number): Promise<DueToken[]> {
  const rows = await db.$queryRaw<Array<DueToken & { prevPrice: Prisma.Decimal | null; prevLiquidity: Prisma.Decimal | null }>>`
    SELECT lower(d."tokenAddress") AS "tokenAddress", lower(d."curveAddress") AS "curveAddress", d."poolId", d."isToken0", d.graduated,
           lower(d."quoteAddress") AS "quoteAddress", s."unchangedReads",
           s."priceQuoteX36" AS "prevPrice", s."liquidityQuote" AS "prevLiquidity"
    FROM "TokenMarketSnapshot" s
    JOIN "DiscoveredToken" d ON d.chain = s.chain AND d."tokenAddress" = s."tokenAddress"
    WHERE s.chain = 'robinhood' AND d."canonicalStatus" = 'CANONICAL' AND (s."nextRefreshAt" IS NULL OR s."nextRefreshAt" <= ${now})
    ORDER BY s."nextRefreshAt" ASC NULLS FIRST, d."sourceHeight" DESC
    LIMIT ${limit}`;
  return rows.map((r) => ({ ...r, prevPrice: r.prevPrice?.toFixed() ?? null, prevLiquidity: r.prevLiquidity?.toFixed() ?? null }));
}

function buildReads(tokens: DueToken[]): { reads: ContractRead[]; plans: Plan[] } {
  const reads: ContractRead[] = [];
  const plans: Plan[] = [];
  for (const token of tokens) {
    const start = reads.length;
    const usePool = token.graduated && token.poolId !== null && token.isToken0 !== null;
    if (usePool) {
      reads.push(
        { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [token.poolId as `0x${string}`] },
        { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [token.poolId as `0x${string}`] }
      );
    } else {
      if (!token.curveAddress) continue;
      for (const fn of CURVE_FNS) reads.push({ address: token.curveAddress, abi: SNAPSHOT_CURVE_ABI, functionName: fn });
    }
    reads.push({ address: token.tokenAddress, abi: ERC20_SUPPLY_ABI, functionName: "totalSupply" }, { address: token.tokenAddress, abi: ERC20_SUPPLY_ABI, functionName: "decimals" });
    let quoteDecimalsIndex: number | null = null;
    if (token.quoteAddress !== NATIVE) {
      quoteDecimalsIndex = reads.length;
      reads.push({ address: token.quoteAddress, abi: ERC20_SUPPLY_ABI, functionName: "decimals" });
    }
    plans.push({ token, kind: usePool ? "pool" : "curve", start, count: reads.length - start, quoteDecimalsIndex });
  }
  return { reads, plans };
}

function interpret(plan: Plan, r: ReadResult[]): { snap: QuoteDenominatedSnapshot; tokenDecimals: number; quoteDecimals: number } {
  const at = (i: number) => r[plan.start + i];
  const tokenDecimals = plan.kind === "pool" ? Number(ok<number>(at(3))) : Number(ok<number>(at(9)));
  const totalSupply = plan.kind === "pool" ? ok<bigint>(at(2)) : ok<bigint>(at(8));
  const quoteDecimals = plan.quoteDecimalsIndex === null ? 18 : Number(ok<number>(r[plan.quoteDecimalsIndex]));
  if (plan.kind === "pool") {
    const [sqrtPriceX96] = ok<readonly [bigint, number, number, number]>(at(0));
    const liquidity = ok<bigint>(at(1));
    return { snap: poolSnapshot({ sqrtPriceX96, liquidity, tokenIsCurrency0: Boolean(plan.token.isToken0), totalSupply }), tokenDecimals, quoteDecimals };
  }
  const [quoteReserve, tokenReserve] = ok<readonly [bigint, bigint]>(at(0));
  const graduated = ok<boolean>(at(5));
  if (graduated) throw new GraduatedWithoutPool();
  const snap = curveSnapshot({
    quoteReserve,
    tokenReserve,
    realQuoteReserve: ok<bigint>(at(1)),
    reservedTokens: ok<bigint>(at(2)),
    launchSupply: ok<bigint>(at(3)),
    sellableTokens: ok<bigint>(at(4)),
    graduated,
    readyToGraduate: ok<boolean>(at(6)),
    graduationThreshold: ok<bigint>(at(7)),
    totalSupply,
  });
  return { snap, tokenDecimals, quoteDecimals };
}

class GraduatedWithoutPool extends Error {
  constructor() {
    super("graduated on chain; pool not indexed yet");
  }
}

class PoolUnresolved extends Error {
  constructor(
    message: string,
    readonly retryMs: number
  ) {
    super(message);
  }
}

type PoolResolution = { ok: true; snap: QuoteDenominatedSnapshot; tokenDecimals: number; quoteDecimals: number } | { ok: false; reason: string; retryMs: number };

/**
 * For tokens whose curve reports graduated but whose pool discovery has not recorded yet: derive
 * the pool the way the quoter does (factory `getLaunchedToken` → PoolKey with the factory's meme
 * hook → PoolId, verified against persisted PoolIds) and accept it only if the hook's registration
 * names this token. Read at the same pinned block as the curve reads.
 */
export async function resolveGraduatedPools(caller: ChainCaller, factory: string, blockNumber: bigint, tokens: DueToken[]): Promise<Map<string, PoolResolution>> {
  const out = new Map<string, PoolResolution>();
  if (tokens.length === 0) return out;
  const first = await multicallAt(caller, blockNumber, [
    { address: factory, abi: PONS_V2_FACTORY_ABI as never, functionName: "memeHook" },
    ...tokens.map((t) => ({ address: factory, abi: PONS_V2_FACTORY_ABI as never, functionName: "getLaunchedToken", args: [t.tokenAddress] })),
  ]);
  const hooks = (first[0]?.ok ? String(first[0].value) : "").toLowerCase();
  const plans: Array<{ token: DueToken; start: number; tokenIsCurrency0: boolean; quoteIndex: number | null }> = [];
  const reads: ContractRead[] = [];
  tokens.forEach((t, i) => {
    const r = first[i + 1];
    if (!hooks || !r?.ok) return out.set(t.tokenAddress, { ok: false, reason: "factory launch record unavailable", retryMs: 5 * 60_000 });
    const launch = r.value as { pairToken: string; poolFee: number; tickSpacing: number; phase: number; exists: boolean };
    if (!launch.exists) return out.set(t.tokenAddress, { ok: false, reason: "factory has no launch for this token", retryMs: 6 * 3_600_000 });
    if (Number(launch.phase) === PONS_V2_PHASE.SWEPT) return out.set(t.tokenAddress, { ok: false, reason: "graduating: curve closed, pool not created yet", retryMs: 60_000 });
    if (Number(launch.phase) === PONS_V2_PHASE.RESCUED) return out.set(t.tokenAddress, { ok: false, reason: "graduation was rescued; no venue trades", retryMs: 6 * 3_600_000 });
    const key = buildPoolKey({ tokenAddress: t.tokenAddress, pairToken: launch.pairToken, poolFee: Number(launch.poolFee), tickSpacing: Number(launch.tickSpacing), hooks });
    const poolId = poolIdFor(key);
    const start = reads.length;
    reads.push(
      { address: hooks, abi: PONS_MEME_HOOK_ABI, functionName: "launches", args: [poolId] },
      { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [poolId] },
      { address: UNISWAP_V4_ROBINHOOD.stateView, abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [poolId] },
      { address: t.tokenAddress, abi: ERC20_SUPPLY_ABI, functionName: "totalSupply" },
      { address: t.tokenAddress, abi: ERC20_SUPPLY_ABI, functionName: "decimals" }
    );
    let quoteIndex: number | null = null;
    if (t.quoteAddress !== NATIVE) {
      quoteIndex = reads.length;
      reads.push({ address: t.quoteAddress, abi: ERC20_SUPPLY_ABI, functionName: "decimals" });
    }
    plans.push({ token: t, start, tokenIsCurrency0: key.currency0 === t.tokenAddress.toLowerCase(), quoteIndex });
  });
  if (reads.length === 0) return out;
  const r = await multicallAt(caller, blockNumber, reads);
  for (const plan of plans) {
    try {
      const info = ok<readonly unknown[]>(r[plan.start]);
      if (!info[0] || Boolean(info[1]) !== plan.tokenIsCurrency0 || String(info[2]).toLowerCase() !== plan.token.tokenAddress) {
        out.set(plan.token.tokenAddress, { ok: false, reason: "hook registration does not match the factory record", retryMs: 30 * 60_000 });
        continue;
      }
      const [sqrtPriceX96] = ok<readonly [bigint, number, number, number]>(r[plan.start + 1]);
      const snap = poolSnapshot({ sqrtPriceX96, liquidity: ok<bigint>(r[plan.start + 2]), tokenIsCurrency0: plan.tokenIsCurrency0, totalSupply: ok<bigint>(r[plan.start + 3]) });
      out.set(plan.token.tokenAddress, { ok: true, snap, tokenDecimals: Number(ok<number>(r[plan.start + 4])), quoteDecimals: plan.quoteIndex === null ? 18 : Number(ok<number>(r[plan.quoteIndex])) });
    } catch (err) {
      out.set(plan.token.tokenAddress, { ok: false, reason: `pool read failed: ${err instanceof Error ? err.message.slice(0, 80) : String(err)}`, retryMs: 5 * 60_000 });
    }
  }
  return out;
}

export async function runSnapshotBatch(options: SnapshotWorkerOptions): Promise<{ read: number; ok: number; failed: number }> {
  const { db, caller, usd } = options;
  const now = (options.now ?? (() => new Date()))();
  const due = await selectDueTokens(db, now, options.batchTokens ?? 150);
  const stats = { read: 0, ok: 0, failed: 0 };
  const per = options.tokensPerMulticall ?? 50;

  for (let i = 0; i < due.length; i += per) {
    const chunk = due.slice(i, i + per);
    const { reads, plans } = buildReads(chunk);
    let results: ReadResult[];
    let pools: Map<string, PoolResolution>;
    let block: { number: bigint; timestamp: bigint };
    try {
      const snap = await snapshotAt(caller, async (b) => {
        const main = await multicallAt(caller, b.number, reads);
        // Curves that report graduated while discovery has no pool yet: resolve their pools at this block.
        const graduatedUnindexed = options.factoryAddress
          ? plans.filter((p) => p.kind === "curve" && main[p.start + 5]?.ok && main[p.start + 5].ok && (main[p.start + 5] as { value: unknown }).value === true).map((p) => p.token)
          : [];
        return { main, pools: options.factoryAddress ? await resolveGraduatedPools(caller, options.factoryAddress, b.number, graduatedUnindexed) : new Map<string, PoolResolution>() };
      });
      if (snap.status !== "OK" || !snap.block || !snap.data) throw new Error(`no consistent block: ${snap.failure ?? "unknown"} ${snap.detail ?? ""}`.trim());
      results = snap.data.main;
      pools = snap.data.pools;
      block = snap.block;
    } catch (err) {
      // The whole batch failed on RPC: retry soon, keep the last good values.
      const message = err instanceof Error ? err.message.split("\n")[0].replace(/https?:\/\/\S+/g, "[url]") : String(err);
      await db.tokenMarketSnapshot.updateMany({
        where: { chain: "robinhood", tokenAddress: { in: chunk.map((t) => t.tokenAddress) } },
        data: { lastError: message.slice(0, 300), nextRefreshAt: new Date(now.getTime() + 2 * 60_000) },
      });
      stats.failed += chunk.length;
      options.log?.(`market snapshot batch failed: ${message.slice(0, 160)}`);
      continue;
    }
    const blockTime = new Date(Number(block.timestamp) * 1000);
    const rates = new Map<string, Awaited<ReturnType<QuoteUsdRateProvider["getHistoricalRate"]>>>();

    for (const plan of plans) {
      stats.read += 1;
      const t = plan.token;
      try {
        const resolved = pools.get(t.tokenAddress);
        if (resolved && !resolved.ok) throw new PoolUnresolved(resolved.reason, resolved.retryMs);
        const { snap, tokenDecimals, quoteDecimals } = resolved?.ok ? resolved : interpret(plan, results);
        if (!rates.has(t.quoteAddress)) rates.set(t.quoteAddress, lookupQuoteAsset(t.quoteAddress) ? await usd.getHistoricalRate({ chain: "robinhood", quoteAddress: t.quoteAddress, at: blockTime }) : { status: "UNAVAILABLE", reason: "unregistered quote" });
        const rate = rates.get(t.quoteAddress)!;
        const usdValues = rate.status === "AVAILABLE" ? toUsd(snap, { token: tokenDecimals, quote: quoteDecimals }, rate.rate.rateUsdPerQuote) : null;
        const changed = t.prevPrice !== snap.priceQuoteX36.toString() || t.prevLiquidity !== snap.liquidityQuote.toString();
        const unchangedReads = changed ? 0 : t.unchangedReads + 1;
        const delay = nextRefreshDelayMs({ changed: changed && t.prevPrice !== null, unchangedReads, graduated: snap.graduated, progressBps: snap.bondingProgressBps, launchedAgeMs: null });
        await db.tokenMarketSnapshot.update({
          where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: t.tokenAddress } },
          data: {
            venue: snap.venue,
            status: "OK",
            lastError: null,
            blockNumber: block.number,
            blockTimestamp: blockTime,
            quoteAddress: t.quoteAddress,
            quoteDecimals,
            tokenDecimals,
            totalSupply: snap.totalSupply.toString(),
            priceQuoteX36: snap.priceQuoteX36.toString(),
            marketCapQuote: snap.marketCapQuote.toString(),
            liquidityQuote: snap.liquidityQuote.toString(),
            priceUsd: usdValues?.priceUsd ?? null,
            marketCapUsd: usdValues?.marketCapUsd ?? null,
            liquidityUsd: usdValues?.liquidityUsd ?? null,
            usdRateSource: rate.status === "AVAILABLE" ? rate.rate.source : null,
            bondingProgressBps: snap.bondingProgressBps,
            quoteRaised: snap.quoteRaised?.toString() ?? null,
            graduationThreshold: snap.graduationThreshold?.toString() ?? null,
            graduated: snap.graduated,
            readyToGraduate: snap.readyToGraduate,
            unchangedReads,
            nextRefreshAt: new Date(now.getTime() + delay),
          },
        });
        if (usdValues) await recordSampleAndChange(db, t.tokenAddress, now, usdValues.marketCapUsd, snap.priceQuoteX36);
        stats.ok += 1;
      } catch (err) {
        const message = err instanceof GraduatedWithoutPool || err instanceof PoolUnresolved ? err.message : `read failed: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`;
        const retry = err instanceof PoolUnresolved ? err.retryMs : err instanceof GraduatedWithoutPool ? 5 * 60_000 : Math.min(30 * 60_000 * 2 ** Math.min(t.unchangedReads, 4), 6 * 3_600_000);
        await db.tokenMarketSnapshot.update({
          where: { chain_tokenAddress: { chain: "robinhood", tokenAddress: t.tokenAddress } },
          data: { status: "FAILED", lastError: message, unchangedReads: t.unchangedReads + 1, nextRefreshAt: new Date(now.getTime() + retry) },
        });
        stats.failed += 1;
      }
    }
  }
  return stats;
}

const SAMPLE_EVERY_MS = 5 * 60_000;

/** Keeps a sample at most every five minutes, and derives the market-cap change against ~1h ago. */
export async function recordSampleAndChange(db: PrismaClient, tokenAddress: string, now: Date, marketCapUsd: string, priceQuoteX36: bigint): Promise<void> {
  const last = await db.tokenMarketSample.findFirst({ where: { chain: "robinhood", tokenAddress }, orderBy: { at: "desc" }, select: { at: true } });
  if (!last || now.getTime() - last.at.getTime() >= SAMPLE_EVERY_MS) {
    await db.tokenMarketSample.create({ data: { chain: "robinhood", tokenAddress, at: now, marketCapUsd, priceQuoteX36: priceQuoteX36.toString() } });
  }
  // The reference is the newest sample between 2h and 55min old; without one there is no 1h change.
  const ref = await db.tokenMarketSample.findFirst({
    where: { chain: "robinhood", tokenAddress, at: { lte: new Date(now.getTime() - 55 * 60_000), gte: new Date(now.getTime() - 2 * 3_600_000) } },
    orderBy: { at: "desc" },
  });
  const current = Number(marketCapUsd);
  const before = ref?.marketCapUsd ? Number(ref.marketCapUsd.toFixed()) : null;
  await db.tokenMarketSnapshot.update({
    where: { chain_tokenAddress: { chain: "robinhood", tokenAddress } },
    data: {
      marketCapChange1hUsd: before === null ? null : (current - before).toFixed(6),
      marketCapChange1hPct: before === null || before === 0 ? null : (((current - before) / before) * 100).toFixed(6),
    },
  });
}

export async function pruneSamples(db: PrismaClient, now = new Date()): Promise<number> {
  const r = await db.tokenMarketSample.deleteMany({ where: { at: { lt: new Date(now.getTime() - 48 * 3_600_000) } } });
  return r.count;
}

/** Background loop for the pons worker. Returns a stop function. */
export function startMarketSnapshotWorker(options: SnapshotWorkerOptions & { intervalMs?: number }): { stop: () => void; idle: () => Promise<void> } {
  let running: Promise<void> | null = null;
  let ticks = 0;
  const timer = setInterval(() => {
    if (running) return;
    running = (async () => {
      // Newly discovered tokens are queued every tick, newest first, so a launch gets its first
      // reading within a tick or two instead of waiting behind the backlog.
      const seeded = await seedSnapshots(options.db, 2_000);
      if (seeded > 0) options.log?.(`market snapshots: queued ${seeded} token(s)`);
      if (ticks % 360 === 0) await pruneSamples(options.db);
      ticks += 1;
      const s = await runSnapshotBatch(options);
      if (s.read > 0 || s.failed > 0) options.log?.(`market snapshots: ${s.ok} ok, ${s.failed} failed`);
    })()
      .catch((err) => options.log?.(`market snapshot tick failed: ${err instanceof Error ? err.message.split("\n")[0].replace(/https?:\/\/\S+/g, "[url]") : String(err)}`))
      .finally(() => {
        running = null;
      });
  }, options.intervalMs ?? 10_000);
  timer.unref();
  return { stop: () => clearInterval(timer), idle: () => running ?? Promise.resolve() };
}
