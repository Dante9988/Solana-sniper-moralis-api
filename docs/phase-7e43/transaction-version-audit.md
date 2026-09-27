# Solana transaction-version audit (Phase 7E.4.3 §0, §20 item 2)

Mainnet returns version-1 transactions. `getTransaction` does **not** degrade for a version the
client cannot read — it refuses the whole request:

```
{"code":-32015,"message":"Transaction version (1) is not supported by the requesting client.
 Please try the request again with the following configuration parameter..."}
```

Observed directly against mainnet on 2026-09-26. That distinction is the whole problem: a reader
pinned too low gets an *error*, which a careless caller reads as "no transaction here" and a
listener then reports itself healthy while dropping real activity.

## Every usage, classified

| Site | Class | State |
|---|---|---|
| `src/solana/transactionVersion.ts` | the single source of truth | `SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION = 1`, `getTransactionConfig()`, `isUnsupportedTransactionVersion()` |
| `src/solana/rpc.ts` | ingestion-critical | goes through `getTransactionConfig()`; a refusal is its own `UNSUPPORTED_TX_VERSION` outcome, never a generic failure and never an empty result |
| `src/transactions.ts` | ingestion-adjacent | migrated to the shared constant |
| `src/forensics/solanaForensicsClient.ts` | forensics | migrated to `getTransactionConfig()`. **Also hardened this phase:** the method accepted a `maxSupportedTransactionVersion` option and spread `options` *after* the centralised config, so any caller could silently override it — exactly the hidden pinned-to-0 path this section set out to remove. The option is deleted and the spread order reversed. Its only caller passes `{}`. |
| `src/pump/scripts/liveCaptureVerification.ts` | script | migrated to the shared constant |
| `src/solana/__tests__/transactionVersion.test.ts`, `pumpfunLive.test.ts` | tests | pass `0` **on purpose**, to prove the refusal is visible rather than silent |

No production path anywhere in `src/` pins a literal version any more. Verified:

```
$ grep -rn "maxSupportedTransactionVersion" src --include="*.ts" | grep -v "src/solana/"
transactions.ts:148:  maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION,
forensics/solanaForensicsClient.ts:501:  // (comment explaining why the override option was removed)
```

## Tests

`src/solana/__tests__/transactionVersion.test.ts` — 8 cases. Offline ones pin the contract and, in
particular, that an ordinary failure (`-32602`, a rate limit, "Transaction not found") is **not**
misclassified as a version problem, because doing so would turn a real outage into a silently
skipped transaction. The live half (`SOLANA_RUN_LIVE_TEST=true`) proves legacy, v0 and v1 all parse
at the supported version, and that pinning 0 produces a visible `-32015` refusal.

Across a 150-second live worker run over 10,747 decoded transactions, `unsupportedTxVersion` was
**0** — and if a future version does appear, it appears as that counter rather than as missing data.
