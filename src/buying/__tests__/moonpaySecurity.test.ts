import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import { MoonPayConfigError, describeMoonPayConfig, loadMoonPayConfig } from "../moonpay/config";
import { moonPayUrlSignature, signMoonPayUrl } from "../moonpay/signing";
import { DEFAULT_TOLERANCE_SECONDS, parseSignatureHeader, signWebhookForTest, verifyMoonPayWebhook } from "../moonpay/webhook";

/**
 * Phase 7D.5.1 — the security-critical half of the MoonPay integration.
 *
 * Procedures verified against MoonPay's docs on 2026-09-20; see
 * docs/phase-7d5-1/source-matrix.md. These tests are what stop "verified" being theatre.
 */

const SANDBOX = {
  MOONPAY_SECRET_KEY: "sk_test_fixture",
  MOONPAY_PUBLISHABLE_KEY: "pk_test_fixture",
  MOONPAY_WEBHOOK_SECRET: "wk_test_fixture",
};

describe("MoonPay config — environment comes from the keys", () => {
  it("returns null when nothing is configured, so the app still boots", () => {
    expect(loadMoonPayConfig({})).toBeNull();
    expect(describeMoonPayConfig(null)).toEqual({ configured: false, environment: null });
  });

  it("derives sandbox from test keys and points at the sandbox widget host", () => {
    const config = loadMoonPayConfig(SANDBOX)!;
    expect(config.environment).toBe("sandbox");
    expect(config.widgetBaseUrl).toBe("https://buy-sandbox.moonpay.com");
  });

  it("refuses a partial set — signing without webhook verification is worse than nothing", () => {
    // URL signing would work while webhooks could not be verified, and an unverified
    // webhook is how a purchase gets faked.
    expect(() => loadMoonPayConfig({ MOONPAY_SECRET_KEY: SANDBOX.MOONPAY_SECRET_KEY })).toThrow(MoonPayConfigError);
  });

  it("refuses keys that mix test and live", () => {
    // A live secret with a test publishable key is how a build that looks like sandbox
    // charges real cards.
    expect(() =>
      loadMoonPayConfig({ ...SANDBOX, MOONPAY_SECRET_KEY: "sk_live_fixture" })
    ).toThrow(/mix test and live/);
  });

  it("refuses live keys unless production is explicitly allowed", () => {
    const live = {
      MOONPAY_SECRET_KEY: "sk_live_fixture",
      MOONPAY_PUBLISHABLE_KEY: "pk_live_fixture",
      MOONPAY_WEBHOOK_SECRET: "wk_live_fixture",
    };
    expect(() => loadMoonPayConfig(live)).toThrow(/MOONPAY_ALLOW_PRODUCTION/);
    expect(loadMoonPayConfig({ ...live, MOONPAY_ALLOW_PRODUCTION: "true" })!.environment).toBe("production");
  });

  it("refuses a key used in the wrong slot", () => {
    expect(() => loadMoonPayConfig({ ...SANDBOX, MOONPAY_SECRET_KEY: SANDBOX.MOONPAY_PUBLISHABLE_KEY })).toThrow(/must be a sk_ key/);
  });

  it("never puts a secret in an error message", () => {
    try {
      loadMoonPayConfig({ ...SANDBOX, MOONPAY_SECRET_KEY: "totally-not-a-key" });
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("totally-not-a-key");
    }
  });

  it("describes configuration without revealing it", () => {
    const described = describeMoonPayConfig(loadMoonPayConfig(SANDBOX));
    expect(described).toEqual({ configured: true, environment: "sandbox" });
    expect(JSON.stringify(described)).not.toMatch(/sk_|pk_|wk_/);
  });
});

describe("widget URL signing", () => {
  const url = "https://buy-sandbox.moonpay.com?apiKey=pk_test_x&currencyCode=eth&walletAddress=0xabc";

  it("signs the query string including the leading ? — the detail MoonPay rejects if wrong", () => {
    const signed = signMoonPayUrl(url, SANDBOX.MOONPAY_SECRET_KEY);
    const expected = createHmac("sha256", SANDBOX.MOONPAY_SECRET_KEY)
      .update("?apiKey=pk_test_x&currencyCode=eth&walletAddress=0xabc")
      .digest("base64");
    expect(new URL(signed).searchParams.get("signature")).toBe(expected);
  });

  it("URL-encodes the signature when appending but not when computing", () => {
    const signed = signMoonPayUrl(url, SANDBOX.MOONPAY_SECRET_KEY);
    const raw = moonPayUrlSignature(url, SANDBOX.MOONPAY_SECRET_KEY);
    // base64 routinely contains + and /, which must be escaped in a query value.
    expect(signed).toContain(`signature=${encodeURIComponent(raw)}`);
    expect(new URL(signed).searchParams.get("signature")).toBe(raw);
  });

  it("changes when any parameter changes — the wallet address must not be tamperable", () => {
    const other = url.replace("0xabc", "0xdef");
    expect(moonPayUrlSignature(url, SANDBOX.MOONPAY_SECRET_KEY)).not.toBe(moonPayUrlSignature(other, SANDBOX.MOONPAY_SECRET_KEY));
  });

  it("refuses to double-sign", () => {
    const signed = signMoonPayUrl(url, SANDBOX.MOONPAY_SECRET_KEY);
    expect(() => signMoonPayUrl(signed, SANDBOX.MOONPAY_SECRET_KEY)).toThrow(/already carries a signature/);
  });
});

describe("webhook verification", () => {
  const secret = SANDBOX.MOONPAY_WEBHOOK_SECRET;
  const body = JSON.stringify({ type: "transaction_updated", data: { id: "tx_1", status: "completed" } });
  const now = () => 1_700_000_000_000;
  const ts = 1_700_000_000;

  it("accepts a correctly signed webhook", () => {
    const header = signWebhookForTest(body, secret, ts);
    expect(verifyMoonPayWebhook(body, header, secret, { now })).toEqual({ ok: true, timestamp: ts });
  });

  it("signs `${timestamp}.${rawBody}` — not the body alone", () => {
    const wrong = `t=${ts},s=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyMoonPayWebhook(body, wrong, secret, { now }).ok).toBe(false);
  });

  it("rejects a re-serialised body, because bytes are what was signed", () => {
    // JSON.parse -> JSON.stringify does not round-trip: key order and spacing move. This is
    // why the route must keep the raw body.
    const header = signWebhookForTest(body, secret, ts);
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    expect(verifyMoonPayWebhook(reserialised, header, secret, { now }).ok).toBe(false);
  });

  it("rejects a forged signature", () => {
    const forged = `t=${ts},s=${"0".repeat(64)}`;
    expect(verifyMoonPayWebhook(body, forged, secret, { now })).toMatchObject({ ok: false, reason: "signature mismatch" });
  });

  it("rejects a signature made with the wrong key", () => {
    const header = signWebhookForTest(body, "wk_test_someoneelse", ts);
    expect(verifyMoonPayWebhook(body, header, secret, { now }).ok).toBe(false);
  });

  it("rejects a replay outside the tolerance window, in both directions", () => {
    const stale = signWebhookForTest(body, secret, ts - DEFAULT_TOLERANCE_SECONDS - 1);
    const future = signWebhookForTest(body, secret, ts + DEFAULT_TOLERANCE_SECONDS + 1);
    expect(verifyMoonPayWebhook(body, stale, secret, { now }).ok).toBe(false);
    expect(verifyMoonPayWebhook(body, future, secret, { now }).ok).toBe(false);
  });

  it("accepts a replay inside the window, so retries and clock drift still work", () => {
    const edge = signWebhookForTest(body, secret, ts - DEFAULT_TOLERANCE_SECONDS + 1);
    expect(verifyMoonPayWebhook(body, edge, secret, { now }).ok).toBe(true);
  });

  it("rejects a missing or malformed header instead of trusting the body", () => {
    expect(verifyMoonPayWebhook(body, undefined, secret, { now })).toMatchObject({ ok: false });
    for (const bad of ["", "nonsense", `s=${"0".repeat(64)}`, `t=abc,s=${"0".repeat(64)}`, "t=1,s=nothex"]) {
      expect(verifyMoonPayWebhook(body, bad, secret, { now }).ok, bad).toBe(false);
    }
  });

  it("parses t and s in either order", () => {
    expect(parseSignatureHeader(`s=${"ab".repeat(32)},t=99`)).toEqual({ timestamp: 99, signature: "ab".repeat(32) });
  });

  it("verifies a Buffer body identically to a string", () => {
    const header = signWebhookForTest(body, secret, ts);
    expect(verifyMoonPayWebhook(Buffer.from(body, "utf8"), header, secret, { now }).ok).toBe(true);
  });
});


describe("strict signature syntax", () => {
  it.each(["t=01", "t=0", "t=Infinity", "t=1e3", "t=9007199254740993", "t=1,t=1", "t=1,unknown=x"])("rejects %s", (timestamp) => {
    expect(parseSignatureHeader(`${timestamp},s=${"ab".repeat(32)}`)).toBeNull();
  });
  it("rejects duplicate signatures", () => {
    expect(parseSignatureHeader(`t=1,s=${"ab".repeat(32)},s=${"ab".repeat(32)}`)).toBeNull();
  });
  it("authenticates the original bytes, including invalid UTF-8", () => {
    const body = Buffer.from([0xff, 0xfe]);
    const ts = 1700000000;
    const hmac = createHmac("sha256", "wk_test_x").update(`${ts}.`).update(body).digest("hex");
    expect(verifyMoonPayWebhook(body, `t=${ts},s=${hmac}`, "wk_test_x", { now: () => ts * 1000 }).ok).toBe(true);
  });
  it("validates the documented account-level webhook key separately", () => {
    expect(() => loadMoonPayConfig({ ...SANDBOX, MOONPAY_WEBHOOK_SECRET: "opaque-legacy-endpoint-secret" })).toThrow(/MOONPAY_WEBHOOK_SECRET/);
    expect(() => loadMoonPayConfig({ ...SANDBOX, MOONPAY_WEBHOOK_SECRET: "wk_live_x" })).toThrow(/mix test and live/);
  });
});
