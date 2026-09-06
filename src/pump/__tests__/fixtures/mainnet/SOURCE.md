# Mainnet fixture provenance

All fixtures are raw `getTransaction` (`encoding: "json"` or `"jsonParsed"`,
`maxSupportedTransactionVersion: 0`) responses fetched from
`api.mainnet-beta.solana.com`, and cross-verified against the project's
actual configured Helius endpoint (`getBlock`/`getTransaction` behavior
confirmed identical) during the Phase 7B.3A0/7B.3A1 audit. No live RPC calls
happen in CI or in the unit tests that consume these files — see
ARCHITECTURE.md's existing `src/forensics/fixtures/fakeClient.ts` precedent
for the same no-live-RPC-in-tests discipline.

Public on-chain data only. No private keys, no PII.

| File | Signature | Slot | Outer tx position | blockTime (unix) | Purpose |
|---|---|---|---|---|---|
| `pump_create_and_dev_buy_with_completion.json` | `4FrprAgt6MmrAdWKqizVStvRDA6Qwd7hFVJG3htvYXgR6jUfoez52p6dLrVYEcPoW391DxQeSW3LqRXEhzr4iGo1` | 444127554 | 381 | 1788487825 | `CreateV2` emitting `CreateEvent`, then a `Buy` in the same tx emitting **both** `TradeEvent` and `CompleteEvent` (the buy that exhausted the curve) |
| `pump_migrate_v2_atomic_pool_creation.json` | `4RHJQg6ETxiFHsxofroxeUcWsPLWmQS1epDySGijsk3jWUid6U3zGAUdXMgZsJUxT6w7iLrzgKwKngG9X1dMHF4W` | 444127554 | 382 | 1788487825 | `MigrateV2` (Pump.fun) CPIs into PumpSwap `CreatePool` and `InitBoost`, emitting `CreatePoolEvent` + `InitBoostEvent` (both PumpSwap self-CPI) + `CompletePumpAmmMigrationEvent` (Pump.fun self-CPI) — 3 events, 2 programs, 1 transaction |
| `pump_sell_via_router.json` | `4HS3PwqK3KNHYQ87UbTxAYZNq5J98StbZdYisf2fZvJWPT558uYF5HwkLdRhwS4g51T5UwS5k25BPcCk8gtF9nsU` | 444175848 | 1238 | 1788503038 | A plain Pump.fun `SellV2` routed through a third-party program (`6Vo3245eszAb5wuqEMw8mGdbfRUdKbHhDHP5LcaGuTAB`) as the outer instruction — proves outer-instruction-program cannot be assumed to be Pump.fun/PumpSwap |
| `pumpswap_buy.json` | `yk3jsbBcpY9rNhgfTaMXYAwKGFp983C1oDJWRgqFEf6qZsr9ThtsAG6Z1abqa7fWr5Rju4vcis6nRR1ZK6WLghJ` | 444182614 | 112 | 1788505173 | Plain PumpSwap `Buy` against pool `D3XknHGytS2yLQNxAJ5EcMjEAT11JKRY6EM5E4jNwFPF` (mint `bKU4TGmXxaMmcjL2htnSKfRT9Voig9KmPvo8Scupump`, quote `So1111...112`). **Verified**: `base_amount_out` (41527) exactly matches the real token-account balance delta; `quote_amount_in` (259656) does **not** match the real SOL debit — `user_quote_amount_in` (260436) does, net of the 20000-lamport tx fee (`meta.fee`) |
| `pumpswap_sell_via_arb_route.json` | `4JNYxvr5ywtZUcwaXYVhQscehK4yGagakMXzXvRGnNzsfxJ3gA64TLJ1fgMWSwFj4fR2Dbp1wrbug2VHv7aPEeX4` | 444188502 | 272 | 1788507031 | A multi-hop arbitrage transaction containing a real `SellEvent` (417 bytes, decoded) plus 2 `BuyEvent`s and an unrelated aggregator swap event, all in one tx. The account this fixture's Sell touches is an intermediate hop with matching pre/post balance in the outer tx (v0/ALT transaction) — **not suitable for isolated sell-side balance-delta verification**; kept as a real successful-`SellEvent` decode fixture only |
| `pumpswap_sell_FAILED_slippage.json` | `4S1JZPmo1yiu4KcN7AsrzUw91cEHa58k6pZ8SehWhHSCroSoYWfyf1cG4RaMLVy8kqvpmjrgZrUahk8pChkk36Xp` | 444189004 | 23 | 1788507188 | A **failed** Sell (`meta.err: {InstructionError: [4, {Custom: 6004}]}`, an Anchor slippage-check revert). Shows `Instruction: Sell` in the logs with **no matching `SellEvent` ever emitted** — proof that `meta.err !== null` must gate ingestion before any log/event inspection, not just "did we find a matching discriminator" |

All fetched and decoded 2026-09-03/04 against `api.mainnet-beta.solana.com`
and cross-checked against the project's live Helius endpoint (host only,
credentials never logged: `mainnet.helius-rpc.com`, `solana-core:
4.2.0-rc.1` per `getVersion`).

IDL source for all decoding: `github.com/pump-fun/pump-public-docs`
(official Pump.fun org), commit `2c22246b6708...` ("feat: pool virtual
quotes reserves", 2026-07-15T18:13:17Z), files `idl/pump.json` and
`idl/pump_amm.json`. No LICENSE file present on that repo — see the
license note in `eventDecoder.ts`'s header comment; this codebase does not
vendor those IDL JSON files, it reimplements only the specific
discriminators and field layouts verified against these fixtures.
