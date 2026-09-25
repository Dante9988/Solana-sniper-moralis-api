/**
 * Phase 7D.5.1 — MoonPay widget URL signing.
 *
 * Procedure verified against MoonPay's documentation on 2026-09-20
 * (`docs/phase-7d5-1/source-matrix.md`):
 *
 *   HMAC-SHA256, key = the **secret** key, message = the URL's query string
 *   **including the leading `?`**, output **base64**, appended as
 *   `&signature=<urlencoded base64>`.
 *
 * Two details are easy to get subtly wrong and both produce a signature MoonPay rejects:
 * the message is `new URL(url).search` (so the `?` is part of it), and the signature is
 * URL-encoded when appended but **not** when computed.
 *
 * A signature is mandatory whenever `walletAddress` is set — which it always is here,
 * because an unsigned wallet address is a parameter anyone could tamper with, and the
 * delivery address is the one parameter that must not be tamperable.
 */

import { createHmac } from "node:crypto";

export function signMoonPayUrl(url: string, secretKey: string): string {
  const parsed = new URL(url);
  if (parsed.searchParams.has("signature")) {
    throw new Error("refusing to sign a URL that already carries a signature");
  }
  // `.search` includes the leading "?" — that is what MoonPay signs.
  const signature = createHmac("sha256", secretKey).update(parsed.search).digest("base64");
  return `${url}&signature=${encodeURIComponent(signature)}`;
}

/**
 * Recompute a URL's signature. Used by tests and by an operator checking a produced link;
 * MoonPay verifies on its side.
 */
export function moonPayUrlSignature(url: string, secretKey: string): string {
  return createHmac("sha256", secretKey).update(new URL(url).search).digest("base64");
}
