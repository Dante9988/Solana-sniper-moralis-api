/**
 * Phase 7B.1 — structured logging with redaction (phase7b1.txt §8). Uses the
 * already-installed `pino` (previously unused). Redaction is enforced by
 * pino itself at serialization time — even a call site that accidentally
 * logs a whole request/headers object never leaks these paths in the
 * output, it prints "[Redacted]" instead.
 */

import pino from "pino";

/** Exported so tests can build a real pino instance against a capturable stream with this exact config, rather than trying to intercept the shared singleton's fd-level writes. */
export const REDACTED_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "*.headers.authorization",
  "*.headers.cookie",
  "*.authorization",
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.accessToken",
  "*.walletPk",
  "*.privateKey",
  "*.secretKey",
  "*.mnemonic",
  "*.seedPhrase",
  "*.databaseUrl",
  "*.DATABASE_URL",
];

export const logger = pino({
  level: process.env.LOG_LEVEL?.trim() || (process.env.VITEST ? "silent" : "info"),
  redact: { paths: REDACTED_PATHS, censor: "[Redacted]" },
});

export type Logger = typeof logger;
