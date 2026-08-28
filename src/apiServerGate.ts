/**
 * Whether src/index.ts's main() should start the trading `/api/*` HTTP
 * server (src/api/index.ts). Extracted as its own zero-dependency module so
 * this fail-closed default (phase7.txt §3: "Default behavior must be API
 * disabled") is unit-testable without importing src/index.ts itself, which
 * has import-time side effects (constructing the live Telegram bot — see
 * ARCHITECTURE.md §2) unsafe to trigger from a test.
 */
export function isApiServerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.API_ENABLED === 'true';
}
