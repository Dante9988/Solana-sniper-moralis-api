/**
 * Phase 7B.5A §7 — Pons worker structured logging with redaction.
 *
 * Phase 7B.4 shipped prefixed `console.log`/`console.warn`/`console.error`
 * calls only (ARCHITECTURE.md §19.9 item 4: "console worker logging lacks
 * Pino redaction"). This reuses the same already-installed `pino` the
 * gateway (src/researchApi/lib/logger.ts) already uses — not a new logging
 * framework — with the same redaction discipline, kept as an independent
 * instance/constant list rather than an import from researchApi so
 * src/pons/** never depends on src/researchApi/** (architecture boundary,
 * phase7b5a.txt §8).
 *
 * Every provider/RPC failure reaching this logger must already be a plain
 * string reason produced by chainClient.ts's typed classifyError — never a
 * raw Error object or the RPC transport's own thrown value, which could
 * embed a credential-bearing URL from the transport's own error message.
 */

import pino from "pino";
import type { DiscoveryListenerLogger } from "./discoveryListener";
import type { TradeListenerLogger } from "./tradeListener";
import type { GraduationPollerLogger } from "./graduationPoller";

const REDACTED_PATHS = ["*.apiKey", "*.api_key", "*.token", "*.accessToken", "*.privateKey", "*.secretKey", "*.mnemonic", "*.seedPhrase", "*.databaseUrl", "*.DATABASE_URL", "*.rpcHttpUrl", "*.rpcWsUrl"];

export const ponsLogger = pino({
  name: "pons",
  level: process.env.LOG_LEVEL?.trim() || (process.env.VITEST ? "silent" : "info"),
  redact: { paths: REDACTED_PATHS, censor: "[Redacted]" },
});

export type PonsLogger = typeof ponsLogger;

/** Adapts the shared redacting Pino instance to each listener's small structured-logger interface, tagged with which loop emitted the line. */
export function ponsComponentLogger(component: string): DiscoveryListenerLogger & TradeListenerLogger & GraduationPollerLogger {
  const child = ponsLogger.child({ component });
  return {
    info: (message, fields) => child.info(fields ?? {}, message),
    warn: (message, fields) => child.warn(fields ?? {}, message),
    error: (message, fields) => child.error(fields ?? {}, message),
  };
}
