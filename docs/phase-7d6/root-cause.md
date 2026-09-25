# Phase 7D.6 §0 — what is actually wrong, measured before changing anything

Investigated 2026-09-25 against the running local stack (fresh live-head session
`e340893c-83a0-4b40-b404-2681f84df2cc`, boundary block 71919205, all streams `LIVE`).

Everything below was reproduced, not inferred. Where a number appears, it came from the
running system.

## The headline: the chart cannot move, and says LIVE while it cannot

The whole backend pipeline works. The break is the last hop.

| Hop | State | Evidence |
| --- | --- | --- |
| on-chain tx → canonical trade | **works** | newest `ChainTrade.sourceTimestamp` 03:51:29 vs DB clock 03:51:38 — ~9s behind chain |
| canonical trade → candle | **works** | for `0xb41c…992a`, 29 `S5` rows written in a 2-minute window, newest `updatedAt` 03:53:23 |
| candle → `token.candle.updated` publish | **works** | `candlesWorkerMain.ts:72` publishes every persisted change |
| publish → WebSocket subscriber | **BROKEN** | authenticated client subscribed to that token's `5s` channel received **0 events in 75s** while those 29 candles were being written |
| REST history | works | `/candles` does not filter on status, so the provisional (active) candle is served |

### Root cause 1 — the event bus is in-process, the publisher is in another process

`REALTIME_BACKEND` is unset locally, and `loadRealtimeConfig` defaults it to `"memory"`
(`src/researchApi/config.ts:204`). `InMemoryEventBus` delivers only within one process.

The candles worker is a **separate process** (`scripts/dev-stack.sh` runs `api`, `pons` and
`candles` independently, deliberately, so one crash cannot take the others down). It publishes
into its own bus instance. Every WebSocket client is held by the API process, which has a
different instance. There is no path between them.

This is not a local-only misconfiguration. It is a footgun in the shape of a default: any
deployment that runs the candles worker apart from the API and does not explicitly set
`REALTIME_BACKEND=redis` gets a chart that can never update, with no error anywhere. Production
at least fails closed (`REALTIME_BACKEND` must be explicit when `NODE_ENV=production`), so the
hole is precisely dev, staging, and anything that forgets — which is where this was found.

**It also lies.** The socket connects, the server sends `connection.ready`, the gateway reports
`"live"`, and the terminal shows a LIVE badge — on a channel that is structurally incapable of
delivering an event. That is a §15 honesty violation independent of the bug: the UI states a
property of the data that the transport cannot provide.

### Root cause 2 — signed-out visitors have no update path at all

`RobinhoodCandleGateway.subscribe` needs a Supabase session, because
`POST /api/v1/realtime/tickets` requires one. Without a session it sets `stopped = true` and
reports `"stale"` (`robinhoodCandleGateway.ts`). Its own comment says it degrades "straight to
polling instead", and `useCandleSeries` has no `refetchInterval` and no timer — **the polling
fallback the comment describes does not exist.** A signed-out visitor gets one REST snapshot and
a frozen chart for as long as the tab stays open.

Honest, because the badge does say stale. Still a dead chart for every anonymous visitor.

### Root cause 3 — the TradingView datafeed discards status entirely

`createDatafeed().subscribeBars` calls the same `gateway.subscribe`, so it inherits root cause 1,
and passes `() => undefined` as the status handler (`tradingViewDatafeed.ts:228`). The Advanced
Chart therefore cannot report stale, delayed or reconnecting at all — it has thrown the signal
away. Whatever fixes delivery must also give this path a way to be honest.

## What is *not* wrong

Worth recording, so the fix does not go looking in the wrong place:

- **Candle math and persistence.** Buckets, revisions and provisional/final status are being
  written correctly and continuously.
- **REST.** `/candles` returns provisional candles, ascending, with `nextCursor`. Polling it
  would show the active candle move today.
- **Finality.** `determineCandleStatus` keys FINAL off the trade checkpoint's confirmed chain
  time, not wall clock — so a stalled worker cannot silently finalise buckets.
- **The frontend's incremental model.** `applyCandleUpdate` already updates in place, and
  `useCandleSeries` already reconciles via REST after a reconnect. Nothing here rebuilds history
  per tick. The plumbing is ready for events that never come.

## A trap that cost time, recorded for the next person

`dev-stack.sh start <service>` **joins the active live-head session**; only `dev-stack.sh start`
with no arguments opens a new one. Starting subsets resumed a session whose boundary was four
days old, which put the streams 2,373,447 and 3,223,431 blocks behind and looked exactly like
broken ingestion. Full `stop` then full `start` produced a fresh boundary and all streams reached
`LIVE` within ~90s, matching the Phase 7D.5 measurement.

`stop` also leaves the `ts-node` child alive; it needed `kill -9` by PID. (And never
`pkill -f` — the pattern matches the calling shell.)

## Screener readiness (§5/§6), measured

Better than expected: the aggregates the brief asks to filter on are **already materialised**.

`computeTrending` (Phase 7D.4) aggregates canonical `ChainTrade` rows in one SQL pass and writes
per-token windows onto `TokenMarketSnapshot`: `volume5mUsd`, `volume1hUsd`, `trades1h`, `buys1h`,
`sells1h`, `traders1h`, `volumeSurge`, `trendingScore`. Discovery already joins that table, so
5m/1h volume, transaction, buy/sell and unique-trader filters can be plain indexed SQL predicates
applied before pagination — no new aggregation layer.

Coverage, counted over 137,607 `OK` snapshots:

| Field | Non-null | Filterable truthfully? |
| --- | --- | --- |
| `marketCapUsd` | 131,926 (96%) | yes — USD is real here, from Chainlink oracle rounds, not estimated |
| `liquidityUsd` | 131,926 (96%) | yes |
| `marketCapQuote` / `liquidityQuote` | 137,607 (100%) | yes |
| `volume5mUsd` / `volume1hUsd` / `trades1h` / `buys1h` / `sells1h` / `traders1h` | materialised by the trending worker | yes, gated on the same coverage rule Trending uses |
| `marketCapChange1hPct` | 2,136 (1.6%) | only where present; needs two snapshots an hour apart |
| any 24h window | **not computed** — `computeTrending` looks back 7h | **no.** Do not expose 24h filters |

Note for the UI: the frontend candle gateway says Robinhood has no USD source. That is true of
the *candle* pricing path (`NullQuoteUsdRateProvider`) and false of the *market snapshot* path,
which uses verified Chainlink rates. Two different providers; do not generalise one to the other.

Existing discovery already does `lifecycle`, `sort`, `q`, cursor pagination and a filtered
`total` server-side, so this phase extends a working contract rather than inventing one.

## Decisions taken from this, before implementing

1. **Deliver events over Postgres `LISTEN`/`NOTIFY`**, as a third `REALTIME_BACKEND`. Every
   process already requires Postgres, so cross-process delivery works in dev, CI and production
   with no service to remember to run — which is the actual failure here. Redis stays supported
   and stays the right answer where it is already deployed.
2. **Never report LIVE on a transport that cannot deliver.** The API knows its own bus backend;
   a subscription on a bus that cannot cross processes must say so, and the client must fall back
   rather than display a frozen LIVE chart.
3. **Ship the polling fallback that was only ever a comment**, adaptive and paused on a hidden
   tab, so signed-out visitors and degraded transports still see the active candle move.
4. **Give the TradingView path the status channel it currently throws away.**
5. **Expose only 5m and 1h windows** in the screener, with 24h omitted and this document cited as
   the reason.

## Measured after the fix (same stack, same probe)

The probe is an authenticated WebSocket client that subscribes to one token's `5s` channel and
counts `token.candle.updated` frames, while the database is checked independently to confirm
candles really are being written for that token in the same window.

| Configuration | Events received | Candles written meanwhile |
| --- | --- | --- |
| Before — `memory` bus, separate worker | **0 in 75s** | 29 `S5` rows for the same token |
| Postgres `LISTEN`/`NOTIFY`, fleet tick only | 1 in 180s | token traded 44× in 5 min |
| Postgres bus + watched-token loop | **16 in 90s** | consecutive 5s buckets, in order |

The middle row is why the watched loop exists. Delivery was fixed, but the fleet tick takes
70–130s per pass (100 tokens, and first-time backfills of a 137k-token universe in the queue),
so freshness for the token you are looking at was a function of how many other tokens existed.
The watched loop costs ~2s per pass for one watched token and leaves the fleet tick untouched.

`candles.subscribed` now precedes any data and carries `push: "live" | "unavailable"`, so a
client on a transport that cannot deliver is told so instead of being shown a frozen LIVE chart.

Also worth recording, because it was a suspicion worth ruling out: the ~28,000 candles written
per fleet tick are **genuine first-time inserts**, not rewrite churn. Every candle row sampled
was at `revision = 1`, and `persistCandleBuckets` already skips unchanged buckets.
