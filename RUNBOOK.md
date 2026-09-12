# Local runtime runbook

> Phase 7D.3 §2. The 7D.2 live demonstration only worked because someone remembered to
> start the PONS worker by hand. This document and `scripts/dev-stack.sh` replace that
> with a repeatable, supervised setup.

## The processes that must run

Discovery is **not** a single process. Each of these is separate on purpose, so one
failing worker does not take the others down and each has its own log and restart
behaviour.

| Service | What it does | Started by | Required for |
|---|---|---|---|
| **PostgreSQL** | Canonical store | Docker / host | Everything |
| **api** | `/api/v1` gateway (`src/researchApi/server.ts`) | `dev-stack.sh` | Frontend, terminal |
| **pons** | Robinhood Chain ingestion (`src/pons/scripts/ponsWorkerMain.ts`) | `dev-stack.sh` | **Discovery — nothing appears without it** |
| **candles** | OHLCV aggregation (`src/candles/scripts/candlesWorkerMain.ts`) | `dev-stack.sh` | Terminal charts |
| **frontend** | Vite dev server | `only-pump-me` repo | UI |
| **bot** | `src/index.ts` — Solana sniper + Discord/Telegram | opt-in only | Alerts, PnL cards |

**If Explore is empty, check `pons` first.** That is the single most common cause: the
API and database are fine, but nothing is writing observations.

## Starting

```bash
# Postgres (host-owned; adjust to your setup)
docker start solana-sniper-postgres

# Backend services
scripts/dev-stack.sh start          # api, pons, candles
scripts/dev-stack.sh status
scripts/dev-stack.sh logs pons

# Frontend (separate repo)
cd ../only-pump-me && npm run dev
```

`start` deliberately excludes **bot**. `src/index.ts` posts to live Discord and Telegram
channels, so it must be opted into explicitly:

```bash
scripts/dev-stack.sh start bot
```

## One-owner protection

Each service records a PID file under `.run/`, and `dev-stack.sh` refuses to start a
second copy while the first is alive (the PID file is cross-checked against
`/proc/<pid>/cmdline`, so a recycled PID does not fool it).

This matters for two specific failures we have actually hit:

- **Two PONS workers** poll the same block ranges and duplicate work.
- **Two bots** fight over Telegram's `getUpdates` lock and produce
  `409 Conflict: terminated by other getUpdates request`, which — before the
  `.catch()` added in Phase 7F.2 — killed the entire detection backend.

Never run `src/index.ts` locally against the **production** `TELEGRAM_BOT_TOKEN` while
production is running. Use a separate test bot, or leave Telegram unset.

## Stopping

```bash
scripts/dev-stack.sh stop           # graceful
scripts/dev-stack.sh stop pons
```

Shutdown sends `SIGTERM` and waits up to 15s before escalating. That wait is not
cosmetic: the PONS worker finishes its in-flight tick and persists its checkpoint on
`SIGTERM`, so killing it outright risks reprocessing a block range on next start.

## Health, lag and checkpoints

```bash
curl -s localhost:8787/api/v1/health    # liveness
curl -s localhost:8787/api/v1/ready     # readiness (database)
curl -s localhost:8787/api/v1/tokens/robinhood/status | jq   # ingestion health
```

Per-source checkpoint state, including lag and last success:

```sql
SELECT source, "lastHeight", "lastObservedChainHeight",
       "lastObservedChainHeight" - "lastHeight" AS lag_blocks,
       "lastSuccessAt", "lastError"
FROM "ChainIngestionCheckpoint";
```

`lag_blocks` is the honest measure of whether ingestion is keeping up. A steadily growing
lag means the worker is alive but falling behind; a stale `lastSuccessAt` with no
`lastError` usually means the process died without shutting down cleanly.

## Restart safety

Ingestion resumes from `ChainIngestionCheckpoint`, not from the chain tip. Verified on
2026-09-12: with checkpoints at `pons:discovery = 60970996` and
`pons_v2:discovery = 60968242`, a full stop/start resumed at blocks `60971003` and
`60968253` respectively, and token counts went 250 → 252 with **250 → 252 distinct
addresses and zero duplicates**.

A source with no checkpoint yet starts ~1000 blocks behind the tip and logs
`starting fresh at height N`. Historical backfill from factory activation is explicitly
out of scope (see `ARCHITECTURE.md` §21).

## Logs

`.run/logs/<service>.log`, git-ignored. `scripts/dev-stack.sh logs <service>` tails one.
