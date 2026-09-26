# Solana finality and reorg model (Phase 7E.4.3 §8)

Every number below was measured against the configured Alchemy mainnet endpoint on
**2026-09-26**. The endpoint URL carries an API key and is never recorded here or logged — only
its host, `solana-mainnet.g.alchemy.com`.

## The two commitments, and why both are needed

```
getSlot(confirmed)  450665109
getSlot(finalized)  450665077     gap: 32 slots  (~13 s)
```

`getBlock` at `finalized` refused every slot newer than about 40 back:

```
slot 450665331 (head-0)   confirmed OK    finalized -32004 Block not available for slot 450665331
slot 450665326 (head-5)   confirmed OK    finalized -32004 Block not available
slot 450665316 (head-15)  confirmed OK    finalized -32004 Block not available
slot 450665291 (head-40)  confirmed OK    finalized OK
```

So there is no single commitment that is both fast enough for discovery and settled enough for an
irreversible decision. The model uses both.

## Observation: `confirmed`

The listener subscribes and fetches at `confirmed`. A token must appear in the product seconds
after it is created, not half a minute later.

Facts written from a not-yet-finalized slot are marked **provisional**:

* `PumpLifecycleEvent.status = "provisional"`
* `ChainTrade` / `DiscoveredToken` are written `CANONICAL`, because they are real observations, and
  are marked `ORPHANED` if reconciliation later finds the transaction gone.

Nothing irreversible may act on a provisional row. That is the contract §13 depends on: a
migration announcement, a performance snapshot or a social post reads `status = "final"` only.

## Reconciliation: `finalized`

`src/solana/pumpfunFinalityReconciler.ts` runs behind the finalized head and, for every
provisional lifecycle event in a slot at or below it, re-fetches the signature at `finalized`:

* present → `final`
* absent → `orphaned`, and every canonical fact from that transaction is marked `ORPHANED` with
  `orphanedAt` set. Rows are never deleted, so orphaned history stays auditable — the same
  convention `src/pons/reorgRecovery.ts` uses for Robinhood.
* an RPC failure, or a transaction version this build cannot parse, is **not** treated as absence.
  The row stays provisional and is retried, because "we could not look" and "it is gone" are
  different facts.

Live behaviour over a 150-second run: 64 events promoted to `final`, 18 still provisional at
shutdown (the most recent slots), **0 orphaned**.

## Candle finality

`src/candles/finality.ts` decides whether a candle bucket may become FINAL from
`ChainIngestionCheckpoint.lastHeightTimestamp`. For this stream that field is advanced **only by the
reconciler**, from a slot it has seen finalized — never by the listener, which runs at `confirmed`.
`lastHeight` still tracks confirmed progress, because that is what recovery needs as its floor. The
two fields answer different questions and are allowed to differ.

Observed in the live run:

```
[solana] finality {"finalizedSlot":450673573,"examined":9,"promoted":9,"orphaned":0,
                   "stillProvisional":0,"checkpointTimestampAdvancedTo":"2026-09-26T12:23:40.000Z"}
```

and the candles that followed: the older 1-minute bar `FINAL`, the newest `PROVISIONAL`.

## What is deliberately not claimed

* **No block-hash-chain reorg walk.** Robinhood Chain's `reorgRecovery.ts` walks parent hashes to
  find a common ancestor. Solana does not expose history that way, and its equivalent guarantee is
  the commitment level itself. `sourceHash` is still a real fact here — the containing block's own
  blockhash from `getBlock` — but it is provenance, not the basis of reorg detection.
* **No claim that `confirmed` never rolls back.** It is rare, not impossible, which is exactly why
  the provisional/final split exists rather than writing everything as settled.
