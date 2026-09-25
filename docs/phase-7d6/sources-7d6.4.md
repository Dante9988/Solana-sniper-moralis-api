# Sources and implementation gap — 2026-09-25

All links accessed 2026-09-25. No external implementation code copied.

| Source | Version / status | Behaviour relied on |
| --- | --- | --- |
| https://www.postgresql.org/docs/current/sql-notify.html | Official PostgreSQL 18 manual; runtime compatible statement trigger semantics | Notifications deliver only after commit; identical notifications coalesce within a transaction; listeners must reconcile after disconnect |
| https://tradingview.github.io/lightweight-charts/docs/api/interfaces/ISeriesApi | Official Lightweight Charts 5.2; installed 5.2.1 | Ordinary update requires a time at least as new as the latest point; setData replaces ordered historical data |
| https://docs.robinhood.com/chain/connecting/ | Official, current | Chain supports standard JSON-RPC and WebSocket endpoints |
| https://geth.ethereum.org/docs/interacting-with-geth/rpc/pubsub | Official Geth docs, edited 2023-08-16 | newHeads includes reorganizations; disconnects require resubscription and historical recovery |
| https://raw.githubusercontent.com/Uniswap/v4-core/main/src/PoolManager.sol | Official repository, main, MIT; no code reused | Swap emits Pool.swap delta before afterSwap hooks |
| https://raw.githubusercontent.com/Uniswap/v4-core/main/src/libraries/Pool.sol | Official repository, main, MIT; no code reused | Exact-input balance delta is negative for input and positive for output |
| https://raw.githubusercontent.com/Uniswap/v4-core/main/src/interfaces/IPoolManager.sol | Official repository, main, MIT | Interface comment calls this a pool balance delta, but implementation and receipt transfers establish the actual signs |
| `src/pons/__tests__/fixtures/rbd_v4_buy_64164797.json` | Verified Robinhood mainnet receipt; chain 4663, block 64164797 | Token is currency1. amount1 positive, amount0 negative; token Transfers leave PoolManager. This is a BUY despite the old decoder labelling it SELL |

Gap: `decodeTrade` copied the V3 sign convention into V4. V4 live ingestion
and historical backfill use the same incorrect decoder, so both labels need repair;
raw absolute amounts and OHLC prices are unaffected by the sign correction.
Fixture recorded before changing normalization. Pool-level V4 execution amounts
exclude subsequent hook/router transfers; do not claim exact wallet-net pricing.

RBD continuity evidence: last curve trade at block 64164794 has raw quote
2516119283476491 and token 121089105356904583236201. First V4 trade at
64164797 has quote 5677920183928647 and token 275522577620316550988686.
Both assets have 18 verified decimals. Normalized prices are 0.000000020779072370
and 0.000000020607821808 respectively. Recent block 72082640 is
0.000003009972190653. There is no orders-of-magnitude decimal/orientation jump
at graduation in these samples. The old screenshot's exact timestamp was not
provided; the samples establish canonical movement, not a match to unseen pixels.


Operational notes:

- Apply the three 20260925 migrations before starting the updated API/workers, then regenerate Prisma. Local and isolated test databases are already migrated.
- Restart worker subsets within the existing ingestion session. A full dev-stack start deliberately opens a new live-head boundary and is not a restart/recovery test.
- `PONS_HEAD_WAKEUP=false` disables the WebSocket scheduling hint; verified HTTP polling remains the canonical ingestion path.
- The candle worker retains polling if its notification listener disconnects. No durable work is owned by the notification payload.
- Keep one candle-worker replica: the per-token exclusion introduced here is process-local. Multi-replica aggregation requires a database claim/advisory lock before scaling.
- The V4 repair script changes only old-version normalized rows, in bounded batches. Do not rerun an unversioned side flip or roll back to the old sign decoder after repairing data.
- A graduated token is advertised as fully backfilled only when both curve and pool cursors cover the target. Market-window coverage additionally checks that this verified range meets the live session boundary (or reaches the current indexed tip).
- Full results and current limitations are in the frontend `docs/phase-7d6/checkpoint-7d6.4.md`. No production deployment is claimed by these local acceptance results.
