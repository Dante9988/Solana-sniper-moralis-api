# Canonical Assets and Research Observations

Phase 4 introduces a read-only, cross-chain identity and observation foundation. It is not wired into listeners, the intelligence orchestrator, Discord, trackers, wallets, or execution.

## Identity rules

- Canonical identity is `chainId + normalizedAddress`.
- Solana mainnet uses chain ID `solana-mainnet`; valid public keys remain case-sensitive.
- Ethereum mainnet uses chain ID `1`.
- BNB Smart Chain mainnet uses chain ID `56`.
- EVM addresses normalize to lowercase, but a supplied display address may retain its original case.
- A chainless EVM address is ambiguous and never defaults to Ethereum.
- Symbol and name are mutable metadata, not identity.

No live Ethereum or BNB provider is included in Phase 4.

## Research versus positions

`POSITION` is reserved for a future portfolio layer and is rejected by the Phase 4 store. Discovery, trending, signal, research, and market observations are PostgreSQL research records; they are never inserted into legacy SQLite holdings.

SQLite continues to own the legacy position tracker. PostgreSQL owns canonical research assets and observations. Chroma may later receive semantic projections, but it is not a source of truth and is not part of this phase.

## Market observations

Market observations retain source, provider, a stable observation key, and observation time. Displayed market price and estimated executable buy/sell prices are separate optional values. Missing evidence stays unavailable rather than becoming zero.

Persistence is idempotent on `(assetId, source, observationKey)`. The timestamp is intentionally not the deduplication key.

## Boundaries

Code in this directory performs no HTTP/RPC calls, polling, Discord activity, SQLite writes, wallet access, signing, transaction construction, or execution. The only side effect is the explicit PostgreSQL store in `assetStore.ts`, using the shared Prisma client.
