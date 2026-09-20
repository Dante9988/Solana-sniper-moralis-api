/**
 * Phase 7D.5.1 — MoonPay configuration, with sandbox/production kept structurally apart.
 *
 * The failure this guards against is the expensive one: shipping a build that looks like
 * sandbox and charges real cards. MoonPay keys carry their own environment in the prefix
 * (`pk_test_` / `sk_test_` / `wk_test_` vs `pk_live_` / …), so the environment is *derived
 * from the keys* rather than from a separate flag someone can forget to flip. A mismatched
 * set, or live keys without an explicit opt-in, refuses to load.
 */

export type MoonPayEnvironment = "sandbox" | "production";

export interface MoonPayConfig {
  readonly environment: MoonPayEnvironment;
  /** Server-side only. Signs widget URLs. Never sent to a browser. */
  readonly secretKey: string;
  /** The only key that may reach the frontend. */
  readonly publishableKey: string;
  /** Server-side only. Verifies webhook signatures. */
  readonly webhookSecret: string;
  /** Host for the hosted checkout, chosen by environment, never by a caller. */
  readonly widgetBaseUrl: string;
}

export class MoonPayConfigError extends Error {}

/** Verified 2026-09-20 against MoonPay's sandbox testing guide. */
const SANDBOX_WIDGET_URL = "https://buy-sandbox.moonpay.com";
const PRODUCTION_WIDGET_URL = "https://buy.moonpay.com";

const KEY_PATTERN = /^(pk|sk|wk)_(test|live)_/;

function environmentOf(name: string, value: string, expectedPrefix: "pk" | "sk" | "wk"): MoonPayEnvironment {
  const match = KEY_PATTERN.exec(value);
  if (!match) {
    // The value is never echoed — an error message carrying a secret is its own incident.
    throw new MoonPayConfigError(`${name} is not a MoonPay key (expected ${expectedPrefix}_test_… or ${expectedPrefix}_live_…)`);
  }
  if (match[1] !== expectedPrefix) {
    throw new MoonPayConfigError(`${name} looks like a ${match[1]}_ key; it must be a ${expectedPrefix}_ key`);
  }
  return match[2] === "live" ? "production" : "sandbox";
}

/**
 * Load MoonPay config, or `null` when it is not configured.
 *
 * Null rather than throwing, so a deployment without MoonPay runs normally and the UI shows
 * "not configured" instead of the API failing to boot.
 */
export function loadMoonPayConfig(env: NodeJS.ProcessEnv = process.env): MoonPayConfig | null {
  const secretKey = env.MOONPAY_SECRET_KEY?.trim();
  const publishableKey = env.MOONPAY_PUBLISHABLE_KEY?.trim();
  const webhookSecret = env.MOONPAY_WEBHOOK_SECRET?.trim();

  if (!secretKey && !publishableKey && !webhookSecret) return null;
  const missing = [
    !secretKey && "MOONPAY_SECRET_KEY",
    !publishableKey && "MOONPAY_PUBLISHABLE_KEY",
    !webhookSecret && "MOONPAY_WEBHOOK_SECRET",
  ].filter(Boolean);
  if (missing.length > 0) {
    // A partial set is worse than none: URL signing would work while webhooks silently
    // could not be verified, and unverified webhooks are how a purchase gets faked.
    throw new MoonPayConfigError(`MoonPay is partly configured; missing ${missing.join(", ")}`);
  }

  const environments = [
    environmentOf("MOONPAY_SECRET_KEY", secretKey!, "sk"),
    environmentOf("MOONPAY_PUBLISHABLE_KEY", publishableKey!, "pk"),
    environmentOf("MOONPAY_WEBHOOK_SECRET", webhookSecret!, "wk"),
  ];
  const unique = [...new Set(environments)];
  if (unique.length > 1) {
    // Mixing a live secret with a test publishable key is how a "sandbox" build takes real
    // money. Refuse rather than pick one.
    throw new MoonPayConfigError("MoonPay keys mix test and live environments; all three must match");
  }

  const environment = unique[0];
  if (environment === "production" && env.MOONPAY_ALLOW_PRODUCTION !== "true") {
    // Live keys need a second, deliberate signal. Business onboarding is not complete, and
    // production must never be reachable by accident.
    throw new MoonPayConfigError("MoonPay live keys are present but MOONPAY_ALLOW_PRODUCTION is not 'true'; refusing to use production");
  }

  return {
    environment,
    secretKey: secretKey!,
    publishableKey: publishableKey!,
    webhookSecret: webhookSecret!,
    widgetBaseUrl: environment === "sandbox" ? SANDBOX_WIDGET_URL : PRODUCTION_WIDGET_URL,
  };
}

/** Safe to log and to return from an API: says what is configured, never what the values are. */
export function describeMoonPayConfig(config: MoonPayConfig | null): { configured: boolean; environment: MoonPayEnvironment | null } {
  return { configured: config !== null, environment: config?.environment ?? null };
}
