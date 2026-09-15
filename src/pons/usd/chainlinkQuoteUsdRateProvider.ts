/**
 * Phase 7D.4 §3 — quote asset -> USD from Chainlink Data Feeds on Robinhood Chain, at a point in time.
 *
 * Implements candles/usdPricing.ts's QuoteUsdRateProvider, so the aggregator and the market-stats
 * service value a trade with the round that was current when the trade's block was produced, never
 * today's price.
 *
 * Fails closed, returning UNAVAILABLE, never an estimate:
 *   - quote asset not in the verified registry (identity by official address only), or no USD feed;
 *   - on-chain description()/decimals() disagree with the registry;
 *   - the round in force at `at` is older than the feed's heartbeat allows (24/5 equity feeds publish
 *     nothing off-hours, so a weekend price is stale rather than "last close") or its answer is <= 0;
 *   - `at` is earlier than the rounds we can walk back to within this aggregator phase;
 *   - the chain itself has stopped producing blocks. Chainlink publishes no L2 sequencer uptime feed
 *     for Robinhood Chain (docs.chain.link/data-feeds/l2-sequencer-feeds, 2026-09-15), so the latest
 *     block's age stands in for the uptime check Robinhood's docs recommend.
 */

import type { Abi } from "viem";

import type { QuoteUsdRateProvider, QuoteUsdRateResult } from "../../candles/usdPricing";
import type { ChainReader } from "../chainClient";
import registry from "./quoteAssetRegistry.robinhood-mainnet.json";

export const AGGREGATOR_V3_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint80", name: "roundId" }, { type: "int256", name: "answer" }, { type: "uint256", name: "startedAt" }, { type: "uint256", name: "updatedAt" }, { type: "uint80", name: "answeredInRound" }],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ type: "uint80", name: "roundId" }],
    outputs: [{ type: "uint80", name: "roundId" }, { type: "int256", name: "answer" }, { type: "uint256", name: "startedAt" }, { type: "uint256", name: "updatedAt" }, { type: "uint80", name: "answeredInRound" }],
  },
] as const satisfies Abi;

export interface RegistryFeed {
  name: string;
  proxy: string;
  decimals: number;
  heartbeatSec: number;
  deviationPct: number;
  marketHours: string | null;
  basis: string;
}

export interface RegistryAsset {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: string;
  feed: RegistryFeed | null;
}

const ASSETS = new Map<string, RegistryAsset>((registry.assets as RegistryAsset[]).map((a) => [a.address.toLowerCase(), a]));

export function lookupQuoteAsset(address: string): RegistryAsset | null {
  return ASSETS.get(address.toLowerCase()) ?? null;
}

type RoundTuple = readonly [bigint, bigint, bigint, bigint, bigint];
interface Round {
  roundId: bigint;
  answer: bigint;
  updatedAt: number;
}

const PHASE_OFFSET = 64n;
const AGGREGATOR_ROUND_MASK = (1n << PHASE_OFFSET) - 1n;
/** Heartbeat slack: publication and block inclusion are not instantaneous. */
const HEARTBEAT_SLACK = 1.1;

/** Decimal string of answer / 10^decimals, exact. */
export function scaleAnswer(answer: bigint, decimals: number): string {
  const negative = answer < 0n;
  const digits = (negative ? -answer : answer).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = decimals > 0 ? digits.slice(digits.length - decimals).replace(/0+$/, "") : "";
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export interface ChainlinkProviderOptions {
  chainClient: ChainReader;
  /** Longest acceptable age of the chain's latest block before USD is withheld. */
  maxChainStallSec?: number;
  /** Cap on rounds walked back per lookup. */
  maxRoundWalk?: number;
  /** Base delay between retries of a failed round read. */
  retryDelayMs?: number;
  now?: () => number;
}

export class ChainlinkQuoteUsdRateProvider implements QuoteUsdRateProvider {
  readonly name = "chainlink-data-feeds (Robinhood Chain)";
  private readonly chainClient: ChainReader;
  private readonly maxChainStallSec: number;
  private readonly maxRoundWalk: number;
  private readonly now: () => number;
  private readonly retryDelayMs: number;
  private readonly verified = new Map<string, Promise<string | null>>();
  private readonly rounds = new Map<string, Map<bigint, Round>>();

  constructor(options: ChainlinkProviderOptions) {
    this.chainClient = options.chainClient;
    this.maxChainStallSec = options.maxChainStallSec ?? 300;
    this.maxRoundWalk = options.maxRoundWalk ?? 2_000;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
  }

  async getHistoricalRate(params: { chain: string; quoteAddress: string; at: Date }): Promise<QuoteUsdRateResult> {
    if (params.chain !== "robinhood") return unavailable(`no USD feeds configured for chain ${params.chain}`);
    const asset = lookupQuoteAsset(params.quoteAddress);
    if (!asset) return unavailable("quote asset is not in the verified registry");
    if (!asset.feed) return unavailable(`no Chainlink USD feed for ${asset.symbol}`);
    const feed = asset.feed;

    const mismatch = await this.verifyFeed(feed);
    if (mismatch) return unavailable(mismatch);

    const liveness = await this.chainLiveness();
    if (liveness) return unavailable(liveness);

    const at = Math.floor(params.at.getTime() / 1000);
    const round = await this.roundAt(feed, at);
    if (typeof round === "string") return unavailable(round);
    if (round.answer <= 0n) return unavailable(`${feed.name} answer is not positive`);
    const maxAge = feed.heartbeatSec * HEARTBEAT_SLACK;
    if (at - round.updatedAt > maxAge) {
      const hours = feed.marketHours && feed.marketHours !== "Crypto" ? ` (feed trades ${feed.marketHours}; no updates off-hours or during corporate actions)` : "";
      return unavailable(`${feed.name} was stale at that time: last update ${at - round.updatedAt}s earlier, heartbeat ${feed.heartbeatSec}s${hours}`);
    }

    return {
      status: "AVAILABLE",
      rate: {
        rateUsdPerQuote: scaleAnswer(round.answer, feed.decimals),
        observedAt: new Date(round.updatedAt * 1000),
        source: `chainlink:${feed.name}:${feed.proxy}:round:${round.roundId.toString()}${asset.kind === "wrapped-native" ? " (WETH valued via ETH/USD)" : ""}`,
      },
    };
  }

  private verifyFeed(feed: RegistryFeed): Promise<string | null> {
    let pending = this.verified.get(feed.proxy);
    if (!pending) {
      pending = (async () => {
        const [description, decimals] = await Promise.all([
          this.chainClient.readContract<string>({ address: feed.proxy, abi: AGGREGATOR_V3_ABI, functionName: "description", args: [] }),
          this.chainClient.readContract<number>({ address: feed.proxy, abi: AGGREGATOR_V3_ABI, functionName: "decimals", args: [] }),
        ]);
        if (description.status !== "AVAILABLE" || decimals.status !== "AVAILABLE") return "feed identity could not be read";
        const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();
        if (!norm(description.data).endsWith(norm(feed.name).replace(/^ROBINHOOD/, "")) || Number(decimals.data) !== feed.decimals) {
          return `feed at ${feed.proxy} reports "${description.data}"/${decimals.data}, registry expects "${feed.name}"/${feed.decimals}`;
        }
        return null;
      })();
      // A transient read failure should be retried next time, not cached forever.
      pending.then((r) => r === "feed identity could not be read" && this.verified.delete(feed.proxy));
      this.verified.set(feed.proxy, pending);
    }
    return pending;
  }

  private livenessCache: { checkedAt: number; result: string | null } | null = null;

  /** Checked at most every 30s: candles value many trades per tick, and liveness does not change per trade. */
  private async chainLiveness(): Promise<string | null> {
    if (this.livenessCache && this.now() - this.livenessCache.checkedAt < 30) return this.livenessCache.result;
    const result = await this.readChainLiveness();
    this.livenessCache = { checkedAt: this.now(), result };
    return result;
  }

  private async readChainLiveness(): Promise<string | null> {
    const head = await this.chainClient.getBlockNumber();
    if (head.status !== "AVAILABLE") return "chain head unavailable";
    const block = await this.chainClient.getBlockRef(head.data);
    if (block.status !== "AVAILABLE") return "chain head unavailable";
    const age = this.now() - Number(block.data.timestamp);
    return age > this.maxChainStallSec ? `chain has not produced a block for ${age}s; prices may be stale (possible sequencer outage)` : null;
  }

  private readonly latest = new Map<string, { round: Round; readAt: number }>();

  private async readRound(feed: RegistryFeed, roundId: bigint | "latest"): Promise<Round | string> {
    const cache = this.rounds.get(feed.proxy) ?? new Map<bigint, Round>();
    this.rounds.set(feed.proxy, cache);
    if (roundId !== "latest" && cache.has(roundId)) return cache.get(roundId)!;
    // The latest round moves, so it is only reused briefly. Candles value thousands of trades per
    // tick; re-reading it for each one turned RPC rate limits into missing USD.
    const recent = roundId === "latest" ? this.latest.get(feed.proxy) : undefined;
    if (recent && this.now() - recent.readAt < 30) return recent.round;

    for (let attempt = 0; attempt < 3; attempt++) {
      const r =
        roundId === "latest"
          ? await this.chainClient.readContract<RoundTuple>({ address: feed.proxy, abi: AGGREGATOR_V3_ABI, functionName: "latestRoundData", args: [] })
          : await this.chainClient.readContract<RoundTuple>({ address: feed.proxy, abi: AGGREGATOR_V3_ABI, functionName: "getRoundData", args: [roundId] });
      if (r.status === "AVAILABLE") {
        const round = { roundId: BigInt(r.data[0]), answer: BigInt(r.data[1]), updatedAt: Number(r.data[3]) };
        if (roundId === "latest") this.latest.set(feed.proxy, { round, readAt: this.now() });
        else cache.set(round.roundId, round); // settled historical rounds never change
        return round;
      }
      if (/revert/i.test(r.reason)) break; // a missing round reverts everywhere; retrying will not help
      await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
    }
    return `${feed.name} round ${roundId.toString()} unavailable`;
  }

  /** The last round whose updatedAt <= at, walking back from the latest within the current phase. */
  private async roundAt(feed: RegistryFeed, at: number): Promise<Round | string> {
    let round = await this.readRound(feed, "latest");
    if (typeof round === "string") return round;
    for (let steps = 0; round.updatedAt > at; steps++) {
      const aggregatorRound = round.roundId & AGGREGATOR_ROUND_MASK;
      if (aggregatorRound <= 1n || steps >= this.maxRoundWalk) {
        return `${feed.name} history before ${new Date(round.updatedAt * 1000).toISOString()} is not reachable from the current aggregator phase`;
      }
      const previous = await this.readRound(feed, round.roundId - 1n);
      if (typeof previous === "string") return previous;
      round = previous;
    }
    return round;
  }
}

function unavailable(reason: string): QuoteUsdRateResult {
  return { status: "UNAVAILABLE", reason };
}
