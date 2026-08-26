/**
 * Phase X — `npm run x:smoke` entrypoint.
 *
 * This is the ONLY place this checkpoint's live request may run. Importing
 * `config.ts`/`xApiClient.ts` has zero side effects; nothing here starts
 * from `npm run dev`, is imported by the active listener, or runs during
 * unit tests. Loads `.env` the same way the repository's other standalone
 * scripts do (`dotenv.config()`), then makes exactly one read-only request.
 *
 * Output is deliberately minimal — see the printed-field lists below, which
 * mirror phaseX.txt's "Safe smoke-test output" section exactly. Never print
 * the bearer token, request headers, the complete response payload, rule
 * values, monitored account names, `.env` contents, or any URL containing
 * credentials.
 */

import dotenv from "dotenv";
dotenv.config();

import { loadXConfig, XConfigError } from "./config";
import { XApiClient } from "./xApiClient";
import { XRateLimitInfo } from "./types";

const CHECKPOINT_NAME = "x-stream-rules-read-checkpoint";

function printRateLimitFields(rateLimit: XRateLimitInfo | undefined, fields: ("limit" | "remaining" | "resetEpochSeconds")[]): void {
  if (!rateLimit) return;
  for (const field of fields) {
    const value = rateLimit[field];
    if (value !== undefined) console.log(`rate limit ${field}: ${value}`);
  }
}

async function main(): Promise<void> {
  console.log(`checkpoint: ${CHECKPOINT_NAME}`);

  let config;
  try {
    config = loadXConfig();
  } catch (err) {
    // Configuration errors never echo the raw env value for X_BEARER_TOKEN —
    // XConfigError messages only ever name the variable, never its content.
    console.log("success: false");
    console.log(`failure category: CONFIGURATION_ERROR`);
    console.log(`reason: ${err instanceof XConfigError ? err.message : "invalid configuration"}`);
    process.exitCode = 1;
    return;
  }

  const client = new XApiClient({ config });
  const result = await client.checkStreamRulesAccess();

  if (result.status === "SUCCESS") {
    console.log("success: true");
    console.log(`http status: ${result.httpStatus}`);
    console.log(`configured rule count returned: ${result.ruleCount}`);
    console.log(`pagination metadata present: ${result.hasMeta}`);
    printRateLimitFields(result.rateLimit, ["limit", "remaining", "resetEpochSeconds"]);
    console.log(`latency ms: ${result.latencyMs}`);
    console.log(`completed at (UTC): ${result.completedAtUtc}`);
    return;
  }

  console.log("success: false");
  console.log(`failure category: ${result.code}`);
  if (result.httpStatus !== undefined) console.log(`http status: ${result.httpStatus}`);
  // "safe retry/reset information" only — the rate-limit reset/remaining
  // values, never the full response or any other field.
  printRateLimitFields(result.rateLimit, ["remaining", "resetEpochSeconds"]);
  process.exitCode = 1;
}

main().catch((err) => {
  console.log("success: false");
  console.log("failure category: UNEXPECTED_ERROR");
  console.error(err instanceof Error ? "unexpected smoke-test error" : "unexpected smoke-test error (non-Error thrown)");
  process.exitCode = 1;
});
