# Phase 7F.1 — Robinhood Account Context

Two independent tracks (see `phase7f1.txt` for the full spec this implements). Don't
conflate them — they have different trust boundaries and different implementation states.

## Track A — Agent surface (done)

OnlyPump never holds or proxies Robinhood credentials or data for this track. The only
deliverable is documentation: `only-pump-me/src/pages/RobinhoodAgentGuide.tsx`
(`/robinhood-agent-guide`), explaining how a user connects Robinhood's own first-party MCP
server (`agent.robinhood.com/mcp/trading`, launched May 27, 2026) alongside OnlyPump's MCP
tools in the same agent client, so their assistant — not OnlyPump's backend — reads across
both.

**Terminology guidance for whoever builds OnlyPump's own MCP tools** (none exist in this
backend yet — confirmed, no `@modelcontextprotocol` dependency or MCP server code anywhere
in `src/` as of this phase): keep field names/vocabulary consistent with Robinhood's own
MCP surface where the concepts overlap, so an agent reasoning across both connectors in one
conversation doesn't have to reconcile two different vocabularies for the same fact. Two
places this matters most, both confirmed live against Robinhood's real MCP tools this
phase:
- **Account identity**: Robinhood's tools distinguish an alphanumeric `account_number` from
  a numeric `rhs_account_number` (securities) / `rhc_account_number` (crypto) — don't invent
  a third naming scheme for the same idea if OnlyPump's tools ever need to reference a
  Robinhood account.
- **P&L shape**: Robinhood's `get_realized_pnl` (bucketed/aggregate) vs `get_pnl_trade_history`
  (per-trade) is a clean, useful split — worth mirroring rather than collapsing into one
  do-everything tool, for the same reason Track B's own `get_position_context` (below) stays
  structured-data-only rather than mixing aggregate and per-trade shapes together.

## Track B — In-app UI surface (design only — not built, not started)

**Hard constraint, non-negotiable**: read-only, account-context-only. No order placement,
no trade-quote generation, no TODO left anywhere for either, against Robinhood-brokerage
assets. This is enforced by omission, not a runtime check to bypass — none of the pieces
below exist yet.

**Why this isn't implemented yet**: `phase7f1.txt`'s own open question — SnapTrade's current
per-user pricing needs a real sales conversation before committing engineering time — is
still unresolved. Building the real integration (not a fixture-only stand-in) against a
provider whose commercial terms aren't confirmed would violate this repo's own standing
rule against mocked-only proof of a real integration. The design below is ready to execute
the moment that's resolved; nothing here should be built against a live SnapTrade account
before then.

### Planned shape (for whoever picks this up, or for the next planning pass)
- **Prisma models**: `LinkedBrokerageAccount` (per-user, per-provider, encrypted OAuth
  token), `BrokeragePositionSnapshot` (versioned, checkpointed — mirrors `DiscoveredToken`'s
  own `canonicalStatus`/`observedAt` discipline, not a new pattern), `BrokerageTrade`
  (mirrors `ChainTrade`'s dedup-by-identity approach).
- **Staleness**: server-computed status per snapshot reusing the existing Pons
  LIVE/LAGGING/DEGRADED/UNAVAILABLE convention (`src/pons/sourceHealth.ts`'s shape) — never
  silently served as fresh past a threshold that should differ market-hours vs. after-hours.
- **`get_position_context` output**: fully structured — entry vs. current price, realized vs.
  unrealized split, position size as % of portfolio, explicit `costBasisUnknown: boolean`
  flag for anything acquired outside the tracked account. Zero free-text from the tool
  itself; the agent explains it.
- **Routes**: `/api/v1/accounts/robinhood/*` under the canonical `src/researchApi/` gateway
  (list positions, position detail, sync status) — same Supabase-JWT auth as everything
  else there, per-connection OAuth tokens encrypted at rest, never sent to the browser.
- **MCP server**: this backend has none today — `get_positions`/`get_position_context`
  would be the first tools in a new MCP server here, not an addition to an existing one.

Full architectural planning (exact schema fields, sync-service checkpointing detail, route
contracts) deliberately deferred to its own pass once the SnapTrade question is resolved —
scoping that now, before the provider question is settled, risks designing against terms
that don't hold.
