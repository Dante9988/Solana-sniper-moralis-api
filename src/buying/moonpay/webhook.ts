/**
 * Phase 7D.5.1 — MoonPay webhook signature verification.
 *
 * Procedure verified against MoonPay's documentation on 2026-09-20
 * (`docs/phase-7d5-1/source-matrix.md`):
 *
 *   Header:  `Moonpay-Signature-V2: t=<unix seconds>,s=<hex hmac>`
 *   Signed:  `${t}.${rawBody}`
 *   HMAC:    SHA-256, **hex** output, key = the **webhook** key (`wk_…`)
 *
 * Three things this file exists to get right, because each one turns "verified" into
 * theatre if it is wrong:
 *
 * 1. **The raw body.** `JSON.parse` then `JSON.stringify` does not round-trip byte-for-byte
 *    — key order, whitespace and number formatting all move — so the signature must be
 *    computed over the exact bytes received. The route mounts a raw body parser for this.
 * 2. **Constant-time comparison.** A `===` on a hex digest leaks, through timing, how much
 *    of a forged signature was correct.
 * 3. **A freshness window.** MoonPay documents no tolerance, so one is chosen here. Without
 *    it a valid signature stays valid forever and a captured webhook can be replayed
 *    indefinitely.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Our choice, not MoonPay's: they document no tolerance. Wide enough for clock drift and retries. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookVerification =
  | { readonly ok: true; readonly timestamp: number }
  | { readonly ok: false; readonly reason: string };

export interface VerifyOptions {
  readonly toleranceSeconds?: number;
  readonly now?: () => number;
}

/** Parse `t=…,s=…`, order-independent, rejecting anything malformed rather than guessing. */
export function parseSignatureHeader(header: string): { timestamp: number; signature: string } | null {
  const parts = header.split(",");
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of parts) {
    const [prefix, ...rest] = part.trim().split("=");
    const value = rest.join("=");
    if (prefix === "t") {
      if (timestamp !== null || !/^[1-9]\d{0,15}$/.test(value)) return null;
      timestamp = Number(value);
      if (!Number.isSafeInteger(timestamp)) return null;
    } else if (prefix === "s") {
      if (signature !== null || !/^[0-9a-f]{64}$/i.test(value)) return null;
      signature = value;
    } else return null;
  }
  if (timestamp === null || signature === null) return null;
  return { timestamp, signature };
}

/**
 * Verify a webhook.
 *
 * `rawBody` must be the exact bytes received. Passing a re-serialised object will fail, and
 * that failure is the correct outcome rather than something to work around.
 */
export function verifyMoonPayWebhook(
  rawBody: Buffer | string,
  header: string | undefined,
  webhookSecret: string,
  options: VerifyOptions = {}
): WebhookVerification {
  if (!header) return { ok: false, reason: "missing Moonpay-Signature-V2 header" };

  const parsed = parseSignatureHeader(header);
  if (!parsed) return { ok: false, reason: "malformed Moonpay-Signature-V2 header" };

  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const age = now - parsed.timestamp;
  if (Math.abs(age) > tolerance) {
    // Future timestamps are rejected too: a clock far ahead is as suspicious as a replay.
    return { ok: false, reason: `timestamp outside ±${tolerance}s tolerance (age ${age}s)` };
  }

  const expected = createHmac("sha256", webhookSecret).update(`${parsed.timestamp}.`).update(rawBody).digest("hex");

  const provided = parsed.signature.toLowerCase();
  if (provided.length !== expected.length) return { ok: false, reason: "signature mismatch" };
  // Lengths are equal here, so timingSafeEqual cannot throw.
  const equal = timingSafeEqual(Buffer.from(provided, "hex"), Buffer.from(expected, "hex"));
  if (!equal) return { ok: false, reason: "signature mismatch" };

  return { ok: true, timestamp: parsed.timestamp };
}

/** Build a header the way MoonPay does. Test-only helper, exported so tests never hand-roll it. */
export function signWebhookForTest(rawBody: string, webhookSecret: string, timestamp: number): string {
  const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  return `t=${timestamp},s=${signature}`;
}
