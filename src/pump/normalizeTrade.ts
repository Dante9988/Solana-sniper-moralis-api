import {
  decodePumpTradeEvent,
  decodePumpSwapBuyEvent,
  decodePumpSwapSellEvent,
} from './eventDecoder';
import { DecodedEventEnvelope, RawTransactionLike, resolveTopLevelCallAccounts } from './eventWalker';
import { PUMPSWAP_BUY_ACCOUNTS, PUMPSWAP_SELL_ACCOUNTS } from './instructionAccounts';
import { PUMP_PROGRAM_ID, PUMPSWAP_PROGRAM_ID } from './discriminators';

/**
 * Matches CANDLESTICK_CHART.md's NormalizedPumpTrade contract exactly
 * (only-pump-me repo). instructionIndex here is the single value the
 * frontend contract expects; the finer-grained identity this backend needs
 * internally (outerInstructionIndex/innerPosition/emittingProgram) lives on
 * EventIdentity, not on this projected type — see eventIdentity.ts.
 */
export interface NormalizedPumpTrade {
  chain: 'solana';
  launchpad: 'pumpfun';
  venue: 'pump' | 'pumpswap';
  mint: string;
  signature: string;
  instructionIndex: number;
  slot: number;
  blockTime: number;
  side: 'buy' | 'sell';
  tokenAmount: string;
  quoteAmount: string;
  quoteMint: string;
  priceQuote: string;
  priceUsd: string | null;
  trader: string;
  observedAt: string;
}

/** Native-SOL and wrapped-SOL are both treated as "SOL-quoted" per the locked candle-projection scope (7B.3A0 round 2, item 8). Confirmed both forms occur on real Pump.fun trades: a fresh bonding-curve CreateEvent/TradeEvent uses the system program id as quote_mint ("11111...111"), PumpSwap trades use wrapped SOL ("So1111...112"). */
export const SOL_QUOTE_MINTS = new Set([
  '11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112',
]);

function decimalDivide(numerator: string, denominator: string, scale = 18): string {
  const n = BigInt(numerator);
  const d = BigInt(denominator);
  if (d === 0n) return '0';
  const scaled = (n * 10n ** BigInt(scale)) / d;
  const negative = scaled < 0n;
  const abs = (negative ? -scaled : scaled).toString().padStart(scale + 1, '0');
  const intPart = abs.slice(0, -scale) || '0';
  const fracPart = abs.slice(-scale).replace(/0+$/, '');
  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${result}` : result;
}

/**
 * Projects one decoded event into NormalizedPumpTrade. Returns null for a
 * non-trade event (CreateEvent, CompleteEvent, migration/pool events) —
 * those feed PumpLifecycleEvent instead, not PumpTrade.
 *
 * blockTime always comes from the transaction's own blockTime, never the
 * event's own on-chain timestamp field, per the explicit override: "Never
 * silently substitute eventTime." The event's timestamp is preserved
 * separately as eventTime on EventIdentity/PumpTrade for provenance, not
 * used as NormalizedPumpTrade.blockTime.
 */
export function normalizeTradeEvent(
  env: DecodedEventEnvelope,
  tx: RawTransactionLike,
  observedAt: string,
): NormalizedPumpTrade | null {
  if (env.blockTime === null) {
    // Fails closed rather than fabricating a blockTime — CANDLESTICK_CHART.md
    // requires a real blockTime; an unconfirmed/unavailable blockTime means
    // this event cannot be normalized yet.
    return null;
  }

  if (env.eventName === 'TradeEvent' && env.emittingProgram === PUMP_PROGRAM_ID) {
    const t = decodePumpTradeEvent(env.payload);
    return {
      chain: 'solana',
      launchpad: 'pumpfun',
      venue: 'pump',
      mint: t.mint,
      signature: env.signature,
      instructionIndex: env.outerInstructionIndex,
      slot: env.slot,
      blockTime: env.blockTime,
      side: t.isBuy ? 'buy' : 'sell',
      tokenAmount: t.tokenAmount,
      quoteAmount: t.quoteAmount,
      quoteMint: t.quoteMint,
      priceQuote: decimalDivide(t.quoteAmount, t.tokenAmount),
      priceUsd: null, // computed at candle-aggregation time, not here — 7B.3A0 round 2, item 6
      trader: t.user,
      observedAt,
    };
  }

  if (env.eventName === 'BuyEvent' && env.emittingProgram === PUMPSWAP_PROGRAM_ID) {
    const ev = decodePumpSwapBuyEvent(env.payload);
    const accounts = env.callAccounts ?? resolveTopLevelCallAccounts(tx, env.outerInstructionIndex);
    if (!accounts || accounts.length <= PUMPSWAP_BUY_ACCOUNTS.quoteMint) {
      // Fail closed: cannot determine mint/quoteMint without the call's
      // account list. Do not guess a mint from anywhere else.
      return null;
    }
    const mint = accounts[PUMPSWAP_BUY_ACCOUNTS.baseMint];
    const quoteMint = accounts[PUMPSWAP_BUY_ACCOUNTS.quoteMint];
    return {
      chain: 'solana',
      launchpad: 'pumpfun',
      venue: 'pumpswap',
      mint,
      signature: env.signature,
      instructionIndex: env.outerInstructionIndex,
      slot: env.slot,
      blockTime: env.blockTime,
      side: 'buy',
      tokenAmount: ev.baseAmountOut,
      // VERIFIED against a real fixture (pumpswap_buy.json): userQuoteAmountIn,
      // not quoteAmountIn, matches the user's actual net-of-tx-fee SOL debit.
      quoteAmount: ev.userQuoteAmountIn,
      quoteMint,
      priceQuote: decimalDivide(ev.userQuoteAmountIn, ev.baseAmountOut),
      priceUsd: null,
      trader: ev.user,
      observedAt,
    };
  }

  if (env.eventName === 'SellEvent' && env.emittingProgram === PUMPSWAP_PROGRAM_ID) {
    const ev = decodePumpSwapSellEvent(env.payload);
    const accounts = env.callAccounts ?? resolveTopLevelCallAccounts(tx, env.outerInstructionIndex);
    if (!accounts || accounts.length <= PUMPSWAP_SELL_ACCOUNTS.quoteMint) {
      return null;
    }
    const mint = accounts[PUMPSWAP_SELL_ACCOUNTS.baseMint];
    const quoteMint = accounts[PUMPSWAP_SELL_ACCOUNTS.quoteMint];
    return {
      chain: 'solana',
      launchpad: 'pumpfun',
      venue: 'pumpswap',
      mint,
      signature: env.signature,
      instructionIndex: env.outerInstructionIndex,
      slot: env.slot,
      blockTime: env.blockTime,
      side: 'sell',
      tokenAmount: ev.baseAmountIn,
      quoteAmount: ev.userQuoteAmountOut,
      quoteMint,
      priceQuote: decimalDivide(ev.userQuoteAmountOut, ev.baseAmountIn),
      priceUsd: null,
      trader: ev.user,
      observedAt,
    };
  }

  return null;
}
