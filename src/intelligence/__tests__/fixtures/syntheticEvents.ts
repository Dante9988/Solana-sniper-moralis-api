import { TokenDiscoveryEvent } from "../../types";

export const pumpfunEvent: TokenDiscoveryEvent = {
  id: "evt-pumpfun-1",
  source: "PUMPFUN",
  signature: "sig-pumpfun-1",
  mint: "SynthMint1111111111111111111111111111pump",
  discoveredAt: new Date("2026-01-01T00:00:00Z"),
  receivedAt: new Date("2026-01-01T00:00:01Z"),
  rawPayload: { logs: [] },
};

export const pumpswapEvent: TokenDiscoveryEvent = {
  id: "evt-pumpswap-1",
  source: "PUMPSWAP",
  signature: "sig-pumpswap-1",
  mint: "SynthMint2222222222222222222222222222pump",
  poolAddress: "SynthPool1111111111111111111111111111111",
  discoveredAt: new Date("2026-01-01T00:05:00Z"),
  receivedAt: new Date("2026-01-01T00:05:01Z"),
  rawPayload: { logs: ["Program log: Instruction: Withdraw"] },
};

export const migrationEvent: TokenDiscoveryEvent = {
  id: "evt-migration-1",
  source: "MIGRATION",
  signature: "sig-migration-1",
  mint: "SynthMint3333333333333333333333333333pump",
  poolAddress: "SynthPool2222222222222222222222222222222",
  discoveredAt: new Date("2026-01-01T00:10:00Z"),
  receivedAt: new Date("2026-01-01T00:10:01Z"),
  rawPayload: { logs: [] },
};
