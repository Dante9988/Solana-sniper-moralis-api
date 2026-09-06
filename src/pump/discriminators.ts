/**
 * Anchor event/program discriminators for the Pump.fun bonding-curve program
 * (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) and the PumpSwap AMM
 * (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA).
 *
 * Source: github.com/pump-fun/pump-public-docs (official Pump.fun org),
 * commit 2c22246b6708... ("feat: pool virtual quotes reserves",
 * 2026-07-15), files idl/pump.json and idl/pump_amm.json. That repo has no
 * LICENSE file, so its IDL JSON is deliberately NOT vendored here — these
 * are just the numeric discriminator/layout facts reimplemented from it,
 * each verified byte-for-byte against a real mainnet transaction fixture
 * in __tests__/fixtures/mainnet/ (see SOURCE.md).
 *
 * EVENT_IX_DISCRIMINATOR is Anchor's fixed self-CPI "event instruction"
 * wrapper (constant across every Anchor program using emit_cpi!) — every
 * self-CPI event instruction's data is
 * [EVENT_IX_DISCRIMINATOR (8 bytes)] + [event-specific discriminator (8 bytes)] + [borsh payload].
 * Confirmed against the real MigrateV2 fixture's CreatePoolEvent inner
 * instruction data this session.
 */

export const EVENT_IX_DISCRIMINATOR = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);

export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const PUMPSWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

export const PUMP_EVENT_DISCRIMINATORS: Record<string, Buffer> = {
  CreateEvent: Buffer.from([27, 114, 169, 77, 222, 235, 99, 118]),
  TradeEvent: Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]),
  CompleteEvent: Buffer.from([95, 114, 97, 156, 212, 46, 152, 8]),
  CompletePumpAmmMigrationEvent: Buffer.from([189, 233, 93, 185, 92, 148, 234, 148]),
};

export const PUMPSWAP_EVENT_DISCRIMINATORS: Record<string, Buffer> = {
  CreatePoolEvent: Buffer.from([177, 49, 12, 210, 160, 118, 167, 116]),
  BuyEvent: Buffer.from([103, 244, 82, 31, 44, 245, 119, 119]),
  SellEvent: Buffer.from([62, 47, 55, 10, 165, 3, 220, 42]),
  InitBoostEvent: Buffer.from([174, 124, 74, 249, 4, 81, 246, 17]),
};

export function findEventName(
  disc: Buffer,
  table: Record<string, Buffer>,
): string | null {
  for (const [name, d] of Object.entries(table)) {
    if (d.equals(disc)) return name;
  }
  return null;
}
