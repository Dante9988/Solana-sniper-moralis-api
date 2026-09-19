# Local runtime runbook

> Phase 7D.3 §2. The 7D.2 live demonstration only worked because someone remembered to
> start the PONS worker by hand. This document and `scripts/dev-stack.sh` replace that
> with a repeatable, supervised setup.
>
> Last updated 2026-09-14 (Phase 7D.3.3): frontend port and CORS, signed-in testing,
> RPC failover, and the database-safety rule for tests.

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
| **frontend** | Vite dev server on **:8080** | `only-pump-me` repo | UI |
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

# Frontend (separate repo). Its .env points at production (https://api.onlypump.me),
# which does not have the newest routes, so override the API base for local work:
cd ../only-pump-me && VITE_API_BASE_URL=http://localhost:8787/api/v1 npm run dev
# → http://localhost:8080  (or http://127.0.0.1:8080)
```

### CORS

The API only answers browsers whose origin is allowed. Outside `NODE_ENV=production` it
accepts `CORS_DEV_ORIGINS`, or, when that is unset, the built-in defaults:
`http://localhost:8080`, `http://127.0.0.1:8080`, `:5173` (both spellings) and the Expo
ports. **`localhost` and `127.0.0.1` are different origins.** If you set
`CORS_DEV_ORIGINS` yourself, list both. The symptom of a miss is a browser console error:
`No 'Access-Control-Allow-Origin' header is present`. Restart the API after changing `.env`.

Check an origin without a browser:

```bash
curl -s -D - -o /dev/null -H "Origin: http://127.0.0.1:8080" \
  localhost:8787/api/v1/tokens/robinhood?limit=1 | grep -i access-control-allow-origin
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

- **Two PONS workers** poll the same block ranges and duplicate work. Workers started by
  hand outside `dev-stack.sh` are invisible to its PID files. Check with
  `ps -eo pid,ppid,lstart,args | grep -E "ponsWorkerMain|candlesWorkerMain" | grep -v grep`
  and stop stale copies by PID (never `pkill -f`, which can match your own shell).
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

## RPC endpoints and quota

Chain reads go through `ROBINHOOD_RPC_HTTPS` → `ROBINHOOD_RPC_HTTPS2` → `ROBINHOOD_RPC_HTTPS3`
→ `DEAFULT_RPC_HTTPS` (same for `*_WSS`). A key that reports quota exhaustion is skipped
for 30 minutes. To rotate a key, replace the value in `.env` and restart. Never paste RPC URLs
into logs, issues or chat: they contain the API key.

Quotes and simulations use `eth_call` with state overrides; an endpoint that does not
support them is skipped for that call. Alchemy-only methods such as `alchemy_getTokenMetadata`
work only on Alchemy endpoints and are not part of failover.

## Signed-in testing (paper positions)

Paper positions need a Supabase user. Use the dedicated test accounts, never a personal one:

- The backend's `SUPABASE_URL` must be the same project as the frontend's `VITE_SUPABASE_URL`
  (currently `weafhrsgxuwrtabkjbmk`).
- Test users are created with the admin API (`email_confirm: true`) using
  `SUPABASE_SECRET_KEY` from the backend `.env`. Email confirmation stays enabled for
  the project. The secret key never goes into the frontend.
- Credentials live in `only-pump-me/.env.e2e.local` (gitignored, mode 600). The browser
  journey is `only-pump-me/docs/phase-7d3-2/auth-journey.cjs`.

## Tests and the database

**Never run the `*_RUN_DB_TESTS` suites against the development database.** They delete
checkpoints and run reorg recovery against a fake chain. On 2026-09-14 this marked 11,977
real Pons V2 launches `ORPHANED` in `solana_bot` (ARCHITECTURE.md §26.4). Vitest now refuses to
start unless the database name contains `test`, `tests`, `ci`, `tmp` or `temp` as a word:

```bash
createdb -h localhost -U <user> ci_local_test
DATABASE_URL=postgresql://…/ci_local_test npx prisma migrate deploy
DATABASE_URL=postgresql://…/ci_local_test PAPER_RUN_DB_TESTS=true npx vitest run --no-file-parallelism
```

**Inspect the database through `DATABASE_URL`, not `docker exec`.** On this machine the listed
`solana-sniper-postgres` container is *not* the app's database; the app reaches a different
Postgres at the same IP (ARCHITECTURE.md §26.4). Use `psql "$DATABASE_URL"` or Prisma.

Fork verification (`evm-verification/scripts/fork-verify.sh`) needs Foundry 1.8.1 and an
archive RPC; see `evm-verification/README.md`.

## Phase 7D.4 settings

- `PONS_MAX_BLOCK_RANGE_PER_POLL` — the local `.env` uses 2000. Alchemy free-tier endpoints cap `eth_getLogs` at 10 blocks; failover now skips them for wide ranges (`RANGE_LIMIT`) instead of cooling them down.
- `PONS_CURVE_TRADES_START_HEIGHT` — optional start block for curve-trade ingestion. Unset starts at the earliest discovered V2 launch.
- `TOKEN_IMAGE_IPFS_GATEWAYS` — put working gateways first. On 2026-09-15 ipfs.io and dweb.link returned 429 for Pons logos; Filebase and Pinata served them.
- **Vanity keystore.**
  - Set `VANITY_KEYSTORE_KEY` with `openssl rand -base64 32`.
  - Set `VANITY_KEYSTORE_DIR` to an absolute path outside the repo, mode 0700.
  - Import with `npm run vanity:import -- --file <generator output> --apply`. Run it without `--apply` first.
  - Delete the plaintext generator file after import.
  - Losing the key makes stored keypairs unusable; losing the key and the directory together exposes them.
- `API_KEYS` — required for the internal consume route. User tokens are refused there.
- `PONS_CURVE_TRADES_MAX_RANGE` — widest curve-trade log window. The local `.env` uses 10000, together with `PONS_MAX_BLOCK_RANGE_PER_POLL=10000` and `PONS_FRESH_START_LOOKBACK_BLOCKS=300000`. The last one gives V4 swaps six hours of baseline when that stream starts.
- `COINGECKO_DEMO_API_KEY` — optional. The Crypto and Stocks lists work without a key at lower limits.
- **Trending is empty.** Check `GET /api/v1/tokens/robinhood?lifecycle=trending`, which returns `trending.reason` with the indexing lag. It turns on by itself once both Pons trade streams are within 10 minutes of the tip.
- **Stopping the pons worker.** `scripts/dev-stack.sh stop` may leave the `node` child running for a few seconds. Stop it by PID. Never use `pkill -f`/`pgrep -f` with a pattern your own shell's command line also contains.

## Phase 7D.5 notes

- **The app database is the `onlypump-pg` container.** `docker start onlypump-pg`. Its data
  lives on the named volume `onlypump-pgdata`, so starting and stopping it is safe. The
  `solana-sniper-postgres` container referenced by older notes no longer exists on this host.
  Still inspect through `DATABASE_URL`, never `docker exec`.
- **Every RPC request carries a `User-Agent`** (`chainClient.ts`). Do not remove it: the
  wide-range endpoint is behind Cloudflare, which answers a request without one with
  `403 / error code: 1010`, and failover then drops to Alchemy keys capped at a 10-block
  `eth_getLogs` range. That single header is the difference between ~10 and ~17,000 blocks/s
  (ARCHITECTURE §28.1).
- **Reading the log window warnings.** `pons:curve-trades` now says when and why it narrows:
  `curve-trade log window 10000 → 5000 blocks after a provider range cap: …`. A narrowing
  after a *provider range cap* is normal — it is finding the real ceiling, which for
  topic-only curve queries is set by viem's 10 MB response cap at roughly 7,500 blocks.
  A window pinned at 10 for many ticks is the pathology fixed in §28.2; check endpoint
  cooldowns before blaming the window.
- **Stopping workers.** `dev-stack.sh stop <svc>` reaps untracked PIDs, but a `ts-node` child
  can survive; check with
  `ps -eo pid,args | grep "[p]onsWorkerMain"` and `kill` by PID.
  Never `pkill -f ponsWorkerMain` — the pattern matches your own shell and kills it.
- **Deployed-secret check (frontend).** `npm run check:deployed-secrets` probes a deployed
  origin for the three burned keypair files. It distinguishes a real file from a SPA
  fallback and prints no response bodies. Run it after every onlypump.me deploy.

## Logs

`.run/logs/<service>.log`, git-ignored. `scripts/dev-stack.sh logs <service>` tails one.
