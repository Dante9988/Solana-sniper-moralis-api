# Phase 7D.5.3 source matrix and gap assessment

Accessed 2026-09-20. Official MoonPay Widget integration only; no headless contracts.
No external implementation copied. API specifications report version 1.0.0.

| Source | Behavior relied on |
| --- | --- |
| https://dev.moonpay.com/widget/on-ramp/customization/url-signing | HMAC SHA256 over query including `?`, base64 then URL encode |
| https://dev.moonpay.com/widget/on-ramp/customization/parameters | currencyCode fixes asset, walletAddress fixes destination, lockAmount fixes amount |
| https://dev.moonpay.com/api-reference/widget/webhooks/signature | V2 signature covers timestamp plus original body bytes |
| https://dev.moonpay.com/api-reference/widget/webhooks.openapi.json | Nested currency.code/metadata.networkCode, updatedAt, unordered at-least-once events |
| https://dev.moonpay.com/api-reference/widget/server-to-server.openapi.json | GET /v1/transactions?externalTransactionId=… with Authorization: Api-Key SECRET; array, including failed transactions |
| https://dev.moonpay.com/api-reference/widget/using-the-api | Shared API origin; key selects environment; secret authentication differs from publishable-key lookups |
| https://support.moonpay.com/en/articles/694414-managing-your-api-keys-domains-and-webhooks | Separately documents pk_test/live, sk_test/live and account-level wk_test/live. Deprecated per-endpoint signing secret is not the current V2 credential. Local credentials match these three documented prefixes; values never recorded. |
| https://dev.moonpay.com/widget/sandbox-testing | Native ETH Sepolia, native SOL Devnet, no sandbox SPL support. Documents 1/100 quoted delivery; observed amounts remain UNVERIFIED until an actual sandbox purchase. |
| https://github.com/josdejong/lossless-json | Lossless numeric parsing to preserve provider decimal amounts; package 4.3.0, MIT, dependency only |

Existing gaps before changes: idempotency key ignored in database queries; no concurrency guard;
reused checkout lacks URL; webhook status rank allows old failures to overwrite completion;
identity fields optional and wrong currency shape; no authenticated recovery API;
quote amount mislabeled delivered amount; card panel unmounted and refresh loses order;
no provider route/DB integration tests. Preserve existing Jupiter corrections and 7G.1 scope.

Regression fixture `moonpay-completed.json` is synthetic with the documented raw wire shape,
not a captured provider transaction. Missing/mismatched identity must fail closed.
Only native ETH and SOL are enabled; no inferred Robinhood or bridging route.

Reachability inspection: repositories contain no approved tunnel. Installed ngrok has only
authentication/version configuration, no named tunnel or route authorization. Prepare a
loopback webhook-only relay on 8788 to API 8787; request approval before opening a tunnel.
