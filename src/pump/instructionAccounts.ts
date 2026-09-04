/**
 * Named account-position tables for the specific (program, instruction)
 * pairs this ingestion pipeline needs to read accounts from directly
 * (rather than from a self-CPI event payload, which does not carry them —
 * see eventDecoder.ts's PumpSwapBuyEvent/PumpSwapSellEvent, neither of
 * which has a mint field).
 *
 * IMPORTANT: Anchor instruction discriminators are only unique WITHIN one
 * program's own namespace — sha256("global:buy") produces the same 8 bytes
 * on Pump.fun's bonding-curve program and on PumpSwap (directly confirmed
 * this session: both are [102,6,61,18,1,218,235,234]). Never key a lookup
 * on discriminator alone; always pair it with the emitting program id.
 *
 * Position order source: github.com/pump-fun/pump-public-docs,
 * idl/pump_amm.json, commit 2c22246b6708... (2026-07-15) — the `accounts`
 * array order Anchor's IDL declares for each instruction. Verified this
 * session against a real transaction: for pumpswap_buy.json, the jsonParsed
 * instruction's flat `accounts` array had base_mint at position 3
 * (bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump, the fixture's own real
 * mint) and quote_mint at position 4 (So1111...112) — both cross-checked
 * against the fixture's known real mint, not assumed from the IDL alone.
 */

import { PUMPSWAP_PROGRAM_ID } from './discriminators';

export const PUMPSWAP_BUY_DISCRIMINATOR = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
export const PUMPSWAP_SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

/** Account name -> position, for PumpSwap's `buy` instruction (pump_amm.json). */
export const PUMPSWAP_BUY_ACCOUNTS = {
  pool: 0,
  user: 1,
  globalConfig: 2,
  baseMint: 3,
  quoteMint: 4,
  userBaseTokenAccount: 5,
  userQuoteTokenAccount: 6,
  poolBaseTokenAccount: 7,
  poolQuoteTokenAccount: 8,
} as const;

/** Account name -> position, for PumpSwap's `sell` instruction — identical
 * leading layout to `buy` in the current IDL, kept as its own named table
 * (not aliased to PUMPSWAP_BUY_ACCOUNTS) so a future IDL change to one
 * doesn't silently change the other. */
export const PUMPSWAP_SELL_ACCOUNTS = {
  pool: 0,
  user: 1,
  globalConfig: 2,
  baseMint: 3,
  quoteMint: 4,
  userBaseTokenAccount: 5,
  userQuoteTokenAccount: 6,
  poolBaseTokenAccount: 7,
  poolQuoteTokenAccount: 8,
} as const;

export const PUMPSWAP_PROGRAM_ID_STR = PUMPSWAP_PROGRAM_ID;
