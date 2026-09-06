import { BorshReader } from './borshReader';

/**
 * Field layouts below are reimplemented from the official
 * github.com/pump-fun/pump-public-docs IDL (idl/pump.json, idl/pump_amm.json,
 * commit 2c22246b6708..., 2026-07-15) and independently verified against
 * real mainnet transaction fixtures in __tests__/fixtures/mainnet/ — each
 * decoder below consumes exactly the fixture's payload length with no
 * leftover bytes (asserted in the corresponding unit test), which is the
 * strongest available proof the field order/types are right without a
 * shared schema library. Do not reorder or add/remove fields without a
 * fixture proving the new layout byte-for-byte (CLAUDE.md external-protocol
 * rule).
 */

export interface PumpTradeEvent {
  mint: string;
  solAmount: string;
  tokenAmount: string;
  isBuy: boolean;
  user: string;
  timestamp: string;
  virtualSolReserves: string;
  virtualTokenReserves: string;
  realSolReserves: string;
  realTokenReserves: string;
  feeRecipient: string;
  feeBasisPoints: string;
  fee: string;
  creator: string;
  creatorFeeBasisPoints: string;
  creatorFee: string;
  trackVolume: boolean;
  totalUnclaimedTokens: string;
  totalClaimedTokens: string;
  currentSolVolume: string;
  lastUpdateTimestamp: string;
  ixName: string;
  mayhemMode: boolean;
  cashbackFeeBasisPoints: string;
  cashback: string;
  buybackFeeBasisPoints: string;
  buybackFee: string;
  quoteMint: string;
  quoteAmount: string;
  virtualQuoteReserves: string;
  realQuoteReserves: string;
}

export function decodePumpTradeEvent(payload: Buffer): PumpTradeEvent {
  const r = new BorshReader(payload);
  const mint = r.pubkey();
  const solAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const user = r.pubkey();
  const timestamp = r.i64();
  const virtualSolReserves = r.u64();
  const virtualTokenReserves = r.u64();
  const realSolReserves = r.u64();
  const realTokenReserves = r.u64();
  const feeRecipient = r.pubkey();
  const feeBasisPoints = r.u64();
  const fee = r.u64();
  const creator = r.pubkey();
  const creatorFeeBasisPoints = r.u64();
  const creatorFee = r.u64();
  const trackVolume = r.bool();
  const totalUnclaimedTokens = r.u64();
  const totalClaimedTokens = r.u64();
  const currentSolVolume = r.u64();
  const lastUpdateTimestamp = r.i64();
  const ixName = r.string();
  const mayhemMode = r.bool();
  const cashbackFeeBasisPoints = r.u64();
  const cashback = r.u64();
  const buybackFeeBasisPoints = r.u64();
  const buybackFee = r.u64();
  // shareholders: vec<Shareholder>, Shareholder = { address: pubkey, share_bps: u16 }
  // (confirmed from pump.json's own Shareholder type definition and
  // byte-exact against the real pump_create_and_dev_buy_with_completion.json
  // fixture, which has shareholders_len=0). Not surfaced on
  // NormalizedPumpTrade — skipped after reading so downstream fields
  // (quote_mint, quote_amount, reserves) land at the right offset.
  const shareholdersLen = r.u32();
  for (let i = 0; i < shareholdersLen; i++) {
    r.pubkey(); // address
    r.u16(); // share_bps
  }
  const quoteMint = r.pubkey();
  const quoteAmount = r.u64();
  const virtualQuoteReserves = r.u64();
  const realQuoteReserves = r.u64();

  return {
    mint, solAmount, tokenAmount, isBuy, user, timestamp,
    virtualSolReserves, virtualTokenReserves, realSolReserves, realTokenReserves,
    feeRecipient, feeBasisPoints, fee, creator, creatorFeeBasisPoints, creatorFee,
    trackVolume, totalUnclaimedTokens, totalClaimedTokens, currentSolVolume,
    lastUpdateTimestamp, ixName, mayhemMode, cashbackFeeBasisPoints, cashback,
    buybackFeeBasisPoints, buybackFee, quoteMint, quoteAmount,
    virtualQuoteReserves, realQuoteReserves,
  };
}

export interface PumpCompleteEvent {
  user: string;
  mint: string;
  bondingCurve: string;
  timestamp: string;
  quoteMint: string;
}

export function decodePumpCompleteEvent(payload: Buffer): PumpCompleteEvent {
  const r = new BorshReader(payload);
  return {
    user: r.pubkey(),
    mint: r.pubkey(),
    bondingCurve: r.pubkey(),
    timestamp: r.i64(),
    quoteMint: r.pubkey(),
  };
}

export interface PumpCreateEvent {
  name: string;
  symbol: string;
  uri: string;
  mint: string;
  bondingCurve: string;
  user: string;
  creator: string;
  timestamp: string;
  virtualTokenReserves: string;
  virtualSolReserves: string;
  realTokenReserves: string;
  tokenTotalSupply: string;
  tokenProgram: string;
  isMayhemMode: boolean;
  isCashbackEnabled: boolean;
  quoteMint: string;
  virtualQuoteReserves: string;
}

export function decodePumpCreateEvent(payload: Buffer): PumpCreateEvent {
  const r = new BorshReader(payload);
  return {
    name: r.string(),
    symbol: r.string(),
    uri: r.string(),
    mint: r.pubkey(),
    bondingCurve: r.pubkey(),
    user: r.pubkey(),
    creator: r.pubkey(),
    timestamp: r.i64(),
    virtualTokenReserves: r.u64(),
    virtualSolReserves: r.u64(),
    realTokenReserves: r.u64(),
    tokenTotalSupply: r.u64(),
    tokenProgram: r.pubkey(),
    isMayhemMode: r.bool(),
    isCashbackEnabled: r.bool(),
    quoteMint: r.pubkey(),
    virtualQuoteReserves: r.u64(),
  };
}

export interface PumpCompletePumpAmmMigrationEvent {
  user: string;
  mint: string;
  mintAmount: string;
  solAmount: string;
  poolMigrationFee: string;
  bondingCurve: string;
  timestamp: string;
  pool: string;
  quoteMint: string;
}

export function decodeCompletePumpAmmMigrationEvent(
  payload: Buffer,
): PumpCompletePumpAmmMigrationEvent {
  const r = new BorshReader(payload);
  return {
    user: r.pubkey(),
    mint: r.pubkey(),
    mintAmount: r.u64(),
    solAmount: r.u64(),
    poolMigrationFee: r.u64(),
    bondingCurve: r.pubkey(),
    timestamp: r.i64(),
    pool: r.pubkey(),
    quoteMint: r.pubkey(),
  };
}

/** Shared trailing-field shape for PumpSwap BuyEvent/SellEvent (post the side-specific prefix). */
interface PumpSwapEventTail {
  pool: string;
  user: string;
  userBaseTokenAccount: string;
  userQuoteTokenAccount: string;
  protocolFeeRecipient: string;
  protocolFeeRecipientTokenAccount: string;
  coinCreator: string;
  coinCreatorFeeBasisPoints: string;
  coinCreatorFee: string;
  cashbackFeeBasisPoints: string;
  cashback: string;
  buybackFeeBasisPoints: string;
  buybackFee: string;
  virtualQuoteReserves: string;
  canBoost: boolean;
  baseSupply: string;
}

export interface PumpSwapBuyEvent extends PumpSwapEventTail {
  timestamp: string;
  baseAmountOut: string;
  maxQuoteAmountIn: string;
  userBaseTokenReserves: string;
  userQuoteTokenReserves: string;
  poolBaseTokenReserves: string;
  poolQuoteTokenReserves: string;
  quoteAmountIn: string;
  lpFeeBasisPoints: string;
  lpFee: string;
  protocolFeeBasisPoints: string;
  protocolFee: string;
  quoteAmountInWithLpFee: string;
  /**
   * The amount actually debited from the user's wallet, net of the network
   * transaction fee. VERIFIED against a real fixture this session:
   * pumpswap_buy.json's user_quote_amount_in (260436) plus meta.fee (20000)
   * equals the user's exact native-SOL balance delta (280436). quoteAmountIn
   * (259656) does NOT match the real debit — it is the pre-fee pool-side
   * amount. Use userQuoteAmountIn for NormalizedPumpTrade.quoteAmount, not
   * quoteAmountIn, despite quoteAmountIn's field-name symmetry with
   * SellEvent.quoteAmountOut looking more "natural."
   */
  userQuoteAmountIn: string;
  trackVolume: boolean;
  totalUnclaimedTokens: string;
  totalClaimedTokens: string;
  currentSolVolume: string;
  lastUpdateTimestamp: string;
  minBaseAmountOut: string;
  ixName: string;
}

export function decodePumpSwapBuyEvent(payload: Buffer): PumpSwapBuyEvent {
  const r = new BorshReader(payload);
  const timestamp = r.i64();
  const baseAmountOut = r.u64();
  const maxQuoteAmountIn = r.u64();
  const userBaseTokenReserves = r.u64();
  const userQuoteTokenReserves = r.u64();
  const poolBaseTokenReserves = r.u64();
  const poolQuoteTokenReserves = r.u64();
  const quoteAmountIn = r.u64();
  const lpFeeBasisPoints = r.u64();
  const lpFee = r.u64();
  const protocolFeeBasisPoints = r.u64();
  const protocolFee = r.u64();
  const quoteAmountInWithLpFee = r.u64();
  const userQuoteAmountIn = r.u64();
  const pool = r.pubkey();
  const user = r.pubkey();
  const userBaseTokenAccount = r.pubkey();
  const userQuoteTokenAccount = r.pubkey();
  const protocolFeeRecipient = r.pubkey();
  const protocolFeeRecipientTokenAccount = r.pubkey();
  const coinCreator = r.pubkey();
  const coinCreatorFeeBasisPoints = r.u64();
  const coinCreatorFee = r.u64();
  const trackVolume = r.bool();
  const totalUnclaimedTokens = r.u64();
  const totalClaimedTokens = r.u64();
  const currentSolVolume = r.u64();
  const lastUpdateTimestamp = r.i64();
  const minBaseAmountOut = r.u64();
  const ixName = r.string();
  const cashbackFeeBasisPoints = r.u64();
  const cashback = r.u64();
  const buybackFeeBasisPoints = r.u64();
  const buybackFee = r.u64();
  const virtualQuoteReserves = r.i128();
  const canBoost = r.bool();
  const baseSupply = r.u64();

  return {
    timestamp, baseAmountOut, maxQuoteAmountIn, userBaseTokenReserves,
    userQuoteTokenReserves, poolBaseTokenReserves, poolQuoteTokenReserves,
    quoteAmountIn, lpFeeBasisPoints, lpFee, protocolFeeBasisPoints, protocolFee,
    quoteAmountInWithLpFee, userQuoteAmountIn, pool, user, userBaseTokenAccount,
    userQuoteTokenAccount, protocolFeeRecipient, protocolFeeRecipientTokenAccount,
    coinCreator, coinCreatorFeeBasisPoints, coinCreatorFee, trackVolume,
    totalUnclaimedTokens, totalClaimedTokens, currentSolVolume, lastUpdateTimestamp,
    minBaseAmountOut, ixName, cashbackFeeBasisPoints, cashback,
    buybackFeeBasisPoints, buybackFee, virtualQuoteReserves, canBoost, baseSupply,
  };
}

export interface PumpSwapSellEvent extends PumpSwapEventTail {
  timestamp: string;
  baseAmountIn: string;
  minQuoteAmountOut: string;
  userBaseTokenReserves: string;
  userQuoteTokenReserves: string;
  poolBaseTokenReserves: string;
  poolQuoteTokenReserves: string;
  quoteAmountOut: string;
  lpFeeBasisPoints: string;
  lpFee: string;
  protocolFeeBasisPoints: string;
  protocolFee: string;
  quoteAmountOutWithoutLpFee: string;
  /** The amount actually credited to the user, symmetric with userQuoteAmountIn on the buy side. */
  userQuoteAmountOut: string;
}

export function decodePumpSwapSellEvent(payload: Buffer): PumpSwapSellEvent {
  const r = new BorshReader(payload);
  const timestamp = r.i64();
  const baseAmountIn = r.u64();
  const minQuoteAmountOut = r.u64();
  const userBaseTokenReserves = r.u64();
  const userQuoteTokenReserves = r.u64();
  const poolBaseTokenReserves = r.u64();
  const poolQuoteTokenReserves = r.u64();
  const quoteAmountOut = r.u64();
  const lpFeeBasisPoints = r.u64();
  const lpFee = r.u64();
  const protocolFeeBasisPoints = r.u64();
  const protocolFee = r.u64();
  const quoteAmountOutWithoutLpFee = r.u64();
  const userQuoteAmountOut = r.u64();
  const pool = r.pubkey();
  const user = r.pubkey();
  const userBaseTokenAccount = r.pubkey();
  const userQuoteTokenAccount = r.pubkey();
  const protocolFeeRecipient = r.pubkey();
  const protocolFeeRecipientTokenAccount = r.pubkey();
  const coinCreator = r.pubkey();
  const coinCreatorFeeBasisPoints = r.u64();
  const coinCreatorFee = r.u64();
  const cashbackFeeBasisPoints = r.u64();
  const cashback = r.u64();
  const buybackFeeBasisPoints = r.u64();
  const buybackFee = r.u64();
  const virtualQuoteReserves = r.i128();
  const canBoost = r.bool();
  const baseSupply = r.u64();

  return {
    timestamp, baseAmountIn, minQuoteAmountOut, userBaseTokenReserves,
    userQuoteTokenReserves, poolBaseTokenReserves, poolQuoteTokenReserves,
    quoteAmountOut, lpFeeBasisPoints, lpFee, protocolFeeBasisPoints, protocolFee,
    quoteAmountOutWithoutLpFee, userQuoteAmountOut, pool, user, userBaseTokenAccount,
    userQuoteTokenAccount, protocolFeeRecipient, protocolFeeRecipientTokenAccount,
    coinCreator, coinCreatorFeeBasisPoints, coinCreatorFee, cashbackFeeBasisPoints,
    cashback, buybackFeeBasisPoints, buybackFee, virtualQuoteReserves, canBoost,
    baseSupply,
  };
}
