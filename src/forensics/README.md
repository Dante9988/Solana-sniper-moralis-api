# Solana Forensics — Phase 5A

Deterministic, read-only Solana bundle/developer/insider/sniper/holder
forensics and the mandatory eligibility policy. Phase 5A delivers **data
contracts and pure policy only** — no Helius/RPC client, no analyzers, no
persistence, and no runtime/listener integration. Those land in later
checkpoints (5B–5E), each requiring its own approval before wiring into the
active listener.

## What's here (Phase 5A)

- `types.ts` — `SolanaTokenForensicsReport`, `ForensicEvidence`,
  `ForensicCoverage`, `WalletRelationshipType`, `WalletClusterClassification`,
  `WalletCluster`, `TokenEligibility`, `TokenEligibilityAssessment`, and every
  other contract from the approved Phase 5 schema.
- `thresholds.ts` — versioned, configurable, environment-overridable
  parameters (launch/sniper windows, funding depth, fresh-wallet lookback,
  FAST/DEEP page/transaction/wallet/credit caps, CAUTION-tier warning
  thresholds). `FORENSICS_POLICY_VERSION` must be bumped on any change.
- `percentageCalculations.ts` — pure bigint-based percentage math. Never
  returns `0` for a missing denominator; returns `undefined` instead.
- `tokenEligibilityPolicy.ts` — `evaluateTokenEligibility()`, the single
  deterministic function implementing the mandatory 40% bundle-exclusion rule
  and the approved CAUTION/UNKNOWN/ELIGIBLE logic. Pure, total, and
  synchronous — no I/O, no AI input, no override parameter of any kind.

## Mandatory policy (non-negotiable)

```text
if initialBundledAcquisitionPct >= 40 OR currentBundleWalletHoldingsPct >= 40
  => EXCLUDED
```

- `40.00%` triggers exclusion; `39.99%` does not.
- Selling bundle holdings down later never erases an initial-acquisition
  exclusion; a cluster growing to 40% later triggers exclusion when it happens.
- Either mandatory metric missing, `PARTIAL`, `UNAVAILABLE`, or
  `ESTIMATED_ONLY` (and neither metric already at/above 40%) forces
  `UNKNOWN` — never `ELIGIBLE`.
- Both mandatory metrics `COMPLETE`, below 40%, and at/above 20%, or any other
  approved CAUTION threshold met, forces `CAUTION`.
- Both mandatory metrics `COMPLETE` and below every warning threshold yields
  `ELIGIBLE`.

This is application code, not a suggestion. `src/forensics/**` must never
accept an AI-produced value that changes `eligibility`.

## Estimated launch supply (§8 limitation)

`initialBundledAcquisitionPct` must only be populated from a reconstructed
launch-slot supply. If launch supply cannot be reconstructed with sufficient
confidence, `initialBundleMetricStatus` is `UNAVAILABLE` (or `ESTIMATED_ONLY`
if a separately labeled, non-authoritative `initialBundleEstimate` is stored
instead). `evaluateTokenEligibility()` never reads `initialBundleEstimate` —
only the authoritative `initialBundledAcquisitionPct` field feeds the policy.

## Danger zone

Code under `src/forensics/**` must never import, directly or transitively:

- `src/transactions.ts`, `src/services/sniperooService.ts`,
  `src/services/tradingService.ts`, `src/pumputils/utils/buyToken.ts`,
  `src/utils/jito.ts`
- `src/tracker/**` writers
- Any `src/discord/**` module (each logs in a live client at import time)
- Wallet/private-key/keypair material (`Keypair`, `sendTransaction`,
  `signTransaction`, `PRIV_KEY_WALLET`, etc.)
- Jupiter execution, Jito bundle submission, Helius Sender, wallet-as-a-service

Phase 5A introduces zero network calls of any kind, so this boundary is
currently satisfied trivially; the boundary test in `__tests__/` exists so it
stays satisfied as 5B–5D add a real (read-only) RPC client and analyzers.

## AI boundary

Anthropic may only ever receive a **finished** `SolanaTokenForensicsReport` +
`TokenEligibilityAssessment` to explain, in later phases. It must not compute
percentages, select cluster membership, or influence `eligibility` in any way.
`tokenEligibilityPolicy.ts` has no code path that reads model output.

## Testing

`npx vitest run src/forensics` — fully mocked/pure, no network, no DB. Covers
every required threshold boundary (39.99% / 40.00% / above 40%, sold-down
persistence, cluster-growth exclusion, incomplete/unavailable/estimated
evidence, all CAUTION thresholds, AI-cannot-override, and the import boundary).
