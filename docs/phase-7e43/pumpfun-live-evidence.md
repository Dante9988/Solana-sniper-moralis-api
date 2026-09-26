# Pump.fun live evidence (Phase 7E.4.3 §17)

Read-only mainnet observation through the configured Alchemy endpoint on **2026-09-26**. Nothing
was signed and no mainnet asset was spent. The endpoint URL carries an API key and appears nowhere
in this document, in logs, or in any error message — only the host,
`solana-mainnet.g.alchemy.com`.

Reproduce with:

```
npm run solana:capture -- 40          # observe + decode, writes nothing
SOLANA_DISCOVERY_ENABLED=true npm run solana:worker
npm run solana:candles
```

## Observation rate

40 seconds of `logsSubscribe(mentions: [6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P])`:

| | |
|---|---|
| notifications | 3,109 (**77.7/s**) |
| of which the chain rejected | 1,373 (44%) |
| successful transactions to follow | ~56/s |
| events decoded | TradeEvent 1,245 · CreateEvent 11 · CompleteEvent 1 · CompletePumpAmmMigrationEvent 1 |
| PumpSwap events seen (not mapped until §14) | CreatePoolEvent 1 · BuyEvent 1 · SellEvent 1 · InitBoostEvent 1 |
| `unsupportedTxVersion` | 0 |

Failed transactions arrive in the same stream as successful ones
(`err: {"InstructionError":[3,{"Custom":6042}]}`), which is why every consumer goes through
`findEvents`, which refuses a failed transaction outright.

## CreateEvent

```
signature trQj2pCpjjgRZDueddjHN5oXqCfEXfzNzhT5TieUmJctTwtJNcZgJBUM5Ku1sZt9f8nhSfdCkaofHDer7KNuN7C
slot      450664977    blockTime 1790423127    outer 2  inner 22
decoded   mint=AsEP39Zd1LkxPUCjZArqCdscTtTDxkqD3GVjLo9Apump symbol=CHESS.FUN
          supply=1000000000000000 curve=BtxyXTp7vgb8JxEFMRhDNeVhtcw9sZDP1X8asdFWJnRe
          quote=11111111111111111111111111111111 creator=FZkRAXkSZaEbJReLbPc64XGcghg3QWsU1yZCfe3SUBJi
```

Canonical `DiscoveredToken`:

```json
{"chain":"solana","venue":"pumpfun","tokenAddress":"AsEP39Zd1LkxPUCjZArqCdscTtTDxkqD3GVjLo9Apump",
 "deployer":"FZkRAXkSZaEbJReLbPc64XGcghg3QWsU1yZCfe3SUBJi","poolAddress":null,
 "quoteAddress":"11111111111111111111111111111111","supply":"1000000000000000",
 "initialBuyAmount":"3529685843060",
 "provenance":{"sourceHeight":"450664977","sourceHash":"Hy5raDF3GbX8LrmTyPR59PDJ6PqEmXyuqN4PCe8TktT6",
   "sourceTxHash":"trQj2pCp…N7C","sourceIndex":8215},
 "metadata":{"name":"Chess.fun","symbol":"CHESS.FUN",
   "metadataUri":"https://ipfs.io/ipfs/QmS135tGYHsuips4QeMsvDkA1Q2ir5rvtiVivHf8MyUUEC",
   "tokenDecimals":6,"quoteDecimals":9,
   "curveAddress":"BtxyXTp7vgb8JxEFMRhDNeVhtcw9sZDP1X8asdFWJnRe"}}
```

Notes on three fields that are easy to get wrong:

* `poolAddress` is **null**. A bonding curve is not a pool; the curve address is recorded as
  `curveAddress`.
* `initialBuyAmount` is the dev buy from the same transaction, matched by mint and side. `0` when a
  create has no accompanying buy — the honest value, not a placeholder for a failed lookup.
* `quoteAddress` is the System Program id, which is pump.fun's sentinel for native SOL. It has no
  mint account, so its 9 decimals come from the protocol's own definition (cross-checked against
  `LAMPORTS_PER_SOL` in the installed @solana/web3.js 1.98.0), not from a read that returned null.

## TradeEvent

```
signature 3wbNnwYZ4fQfrYf3znxuyWoMLEaskfpvq2goiYvDfH4yNbCz83V6KNENat9hAXa1aBvZjLmrZc4jgTNJVuNtNUjZ
slot      450664960    blockTime 1790423122    outer 0  inner 3
decoded   mint=CayDdZ1sTiwzP9DabqhzQTvpiUr42puXDUnTP25vpump side=sell token=553345640901
          quote=15528867 quoteMint=11111111111111111111111111111111
          trader=9X1EVxtKhMGun8oP1GvAvgtQ3tPvCyXNzrcChR86ykhx
```

Canonical `ChainTrade` — raw integer amounts exactly as the chain reported them, `priceQuote` the
raw ratio (the same convention every other venue's adapter uses), `priceUsd` null because USD needs
a dated rate the adapter has no access to:

```json
{"chain":"solana","venue":"pump","side":"sell","tokenAmount":"553345640901","quoteAmount":"15528867",
 "quoteAddress":"11111111111111111111111111111111","priceQuote":"0.000028063593262819","priceUsd":null,
 "provenance":{"sourceHeight":"450664960","sourceHash":"FemcEqSxDbVM1NxiY9xg3xQgpd7SbZa7CpXj4h3JdxgN",
   "sourceIndex":4}}
```

## Lifecycle: the same mint, three slots apart

This is the §12 distinction, caught live on one token:

| slot | event | signature | phase |
|---|---|---|---|
| 450665003 | `CompleteEvent` | `3X5SSg3PNEDm3Whi2kmmBn1uLtoAKC6jvNchVyz2sMTeLSnBhX6ZgNjohmMQhK5Zdg1EowcyCrjrsMZkMhiQxTfP` | `bonding_complete` |
| 450665006 | `CompletePumpAmmMigrationEvent` | `2JSzMvBKxEaRPzMgsbx5iT8Ch4Q4JPvqLp8ZxALPJEhjeUK8eptretfkz3ArVLf5k1dx4ZpYgKTEnyTQFAGqi4W8` | `pumpswap` |

mint `35ynznV9r2RVSXYDrZtfsngvLRrkD3iGKjzv5c3U2i7u`, curve
`275yu8U8AcjMc7uaGHMgwWZAjmA5Fyo4eEhCwUFYRt18`, destination pool
`3oP7CokyBZjwA14iTjaTSHitmF5UWkWaGjZqp5Xxentt`.

For **three slots** that token's curve was complete and it had no destination pool. Calling
`CompleteEvent` "migrated" would have been wrong for that window, and would stay wrong for any token
whose migration fails or is delayed. `CompleteEvent` names no pool, so `destinationVenue` and
`destinationPool` are null; only `CompletePumpAmmMigrationEvent` names one, and it creates that pool
in the same transaction — which is what makes graduation here event-sourced and pool-proven.

## End-to-end worker run (150 s)

```json
{"observed":40021,"observedFailedTx":29295,"decoded":10747,"persisted":4572,"duplicate":10,
 "failed":0,"unsupportedTxVersion":0,"notFoundAtCommitment":246,"deferredToRecovery":0,
 "blockIdentityMissing":0,"tradesForUnknownToken":4420,"unmappedEvents":16,"queueOverflowed":0,
 "solanaLiveHeadSlot":450674034,"solanaProcessedSlot":450674063,"solanaFinalizedSlot":450674002}
```

Rows written:

| | |
|---|---|
| `DiscoveredToken` (chain `solana`) | **78**, all 78 with verified token and quote decimals |
| `ChainTrade` (chain `solana`) | **4,412** |
| `PumpLifecycleEvent` | 82 — `created` 78, `completed` 2, `pumpswap_pool_created` 2 |
| `TokenLifecycleState` | 79 — `bonding_curve` 77, `pumpswap` 2 |
| lifecycle status | `final` 64, `provisional` 18, `orphaned` 0 |

`notFoundAtCommitment: 246` with `deferredToRecovery: 0` is the important pair: the WebSocket
announces a signature roughly 3 seconds before the RPC will return the transaction (measured: 242 of
1,736 immediate fetches returned null; all 20 sampled resolved once ~3 s had passed). Every one of
those 246 was resolved by retry. A listener that read null as "no events here" would have dropped
~14% of live activity while reporting itself perfectly healthy.

`tradesForUnknownToken: 4420` are trades of tokens created before observation began. They are
counted, not silently dropped: nothing downstream can price a trade whose token has no verified
decimals, and local development deliberately starts at the chain head rather than replaying history.

## Candles, from those same rows

`npm run solana:candles` — the existing `runCandleAggregationTick`, pointed at `chain: "solana"`,
with an EVM chain client that throws on every method (so needing one would fail loudly):

```
tick 1: {"tokensProcessed":78,"candlesWritten":2651,"bucketsRecomputed":2651,"errors":[]}
tick 2: {"tokensProcessed":0,"candlesWritten":0,...}      <- nothing left to do; idempotent
```

| resolution | bars | tokens | trades counted |
|---|---|---|---|
| 1s | 1,438 | 78 | 4,412 |
| 5s | 542 | 78 | 4,412 |
| 15s | 273 | 78 | 4,412 |
| **1m** | **131** | 78 | **4,412** |
| **5m** | **111** | 78 | **4,412** |
| 15m | 78 | 78 | 4,412 |
| 1h | 78 | 78 | 4,412 |

Every resolution counts exactly 4,412 trades — the same number as the `ChainTrade` rows. No trade is
double counted anywhere, and a second tick writes nothing, so there are no duplicate bars.

Two real 1-minute bars (mint `BzxBydMD1svkz7gYd6muRf2PsZUdz7uzedv9h9L6pump`, "Annette"):

```
12:24:00Z o=0.000000041283703659 h=0.000000221529000452 l=0.000000033021527278 c=0.000000200032020775
          volTok=2319458703.243961 volQuote=206.930132533 volUsd=null n=403 traders=202 FINAL
12:25:00Z o=0.000000199805473205 h=0.000000254899001833 l=0.000000150750636507 c=0.000000233085002035
          volTok=707252436.897579  volQuote=139.414342384 volUsd=null n=387 traders=231 PROVISIONAL
```

`volumeToken` and `volumeQuote` are decimals-normalized whole units (6-decimal token, 9-decimal
native SOL). `volumeUsd` is **null**, and that is the correct answer: no trusted historical SOL/USD
source is configured in this repository, and §10 requires an untrustworthy USD figure to be
unavailable rather than estimated. The quote-denominated candle is complete and fully usable.
