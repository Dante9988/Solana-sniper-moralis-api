/**
 * Phase 7D.3 — RPC endpoint inventory and failover policy.
 *
 * Pure: parsing, ordering, classification and cooldown arithmetic, with no I/O, so the
 * rules are testable without a network. `failoverChainClient.ts` applies them.
 *
 * Why this exists: on 2026-09-12 the primary Alchemy endpoint returned
 * "Monthly capacity limit exceeded" and every Robinhood Chain read stopped — ingestion,
 * pool evidence, the terminal. A configured secondary was healthy the whole time and went
 * unused because nothing could fail over to it.
 *
 * **URLs are secrets.** They embed provider API keys, so nothing here ever returns a full
 * URL for logging or metrics — only `label` (the env var name) and `host`.
 */

/** Env var names, in priority order. `DEAFULT` is the real spelling in .env — do not "fix" it. */
/**
 * Private provider keys first, in order, then the public default. Adding a key is how quota
 * exhaustion is absorbed: an exhausted key is cooled down for COOLDOWN_MS.QUOTA_EXHAUSTED and
 * traffic rotates to the next one without a restart.
 */
export const HTTP_ENDPOINT_VARS = [
  "ROBINHOOD_RPC_HTTPS",
  "ROBINHOOD_RPC_HTTPS2",
  "ROBINHOOD_RPC_HTTPS3",
  "DEAFULT_RPC_HTTPS",
] as const;

export const WS_ENDPOINT_VARS = [
  "ROBINHOOD_RPC_WSS",
  "ROBINHOOD_RPC_WSS2",
  "ROBINHOOD_RPC_WSS3",
  "DEAFULT_RPC_WSS",
] as const;

export interface RpcEndpoint {
  /** The env var this came from. Safe to log. */
  label: string;
  /** Hostname only. Safe to log — never carries the key. */
  host: string;
  /** The full URL, including any API key. NEVER log or serialize this. */
  url: string;
  /** 0 = highest priority. */
  priority: number;
}

/**
 * Failure classes, because they need very different responses.
 *
 * The distinction that matters most: a contract revert or an unsupported method is a fact
 * about the *request*, not a sick endpoint. Failing over on those would stampede every
 * provider with a call that is going to fail everywhere, and would mask real bugs.
 */
export type RpcFailureClass =
  | "QUOTA_EXHAUSTED" // monthly/plan cap — long cooldown, retrying is pointless
  | "RATE_LIMITED" // per-second throttle — short cooldown, honour Retry-After
  | "TIMEOUT"
  | "CONNECTION"
  | "SERVER_ERROR" // retryable 5xx
  | "WRONG_CHAIN" // wrong chainId — never use, regardless of health
  | "STALE" // too far behind for the requested operation
  | "RANGE_LIMIT" // this endpoint's plan caps eth_getLogs ranges — try the next one, no cooldown
  | "BOT_CHALLENGE" // a CDN/bot shield rejected the request before the node saw it — fix the request, not the key
  | "REQUEST_FAULT"; // revert / invalid params / unsupported method — do NOT fail over

/** Cooldowns, in ms, applied to an endpoint after a failure of each class. */
export const COOLDOWN_MS: Record<RpcFailureClass, number> = {
  // A monthly cap does not clear in minutes. Hammering it wastes latency on every
  // request and can extend provider-side penalties.
  QUOTA_EXHAUSTED: 30 * 60_000,
  RATE_LIMITED: 15_000,
  TIMEOUT: 10_000,
  CONNECTION: 20_000,
  SERVER_ERROR: 10_000,
  WRONG_CHAIN: 24 * 60 * 60_000,
  STALE: 30_000,
  // The endpoint is healthy; it just cannot serve this particular request shape.
  RANGE_LIMIT: 0,
  // The node is fine and the key is fine; a shield in front of it refused the request
  // shape. A 30-minute quota cooldown here is actively harmful — it parks a healthy
  // endpoint — so this is short, and the distinct label is what tells an operator to
  // look at request headers instead of at billing.
  BOT_CHALLENGE: 60_000,
  REQUEST_FAULT: 0,
};

/** Failure classes that should move the request to the next endpoint. */
export function shouldFailover(failure: RpcFailureClass): boolean {
  return failure !== "REQUEST_FAULT";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

/**
 * Build the ordered endpoint list.
 * Empty entries are skipped and duplicate URLs collapse to their highest priority, so a
 * copy-pasted value cannot silently consume a failover slot.
 */
export function resolveEndpoints(
  vars: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): RpcEndpoint[] {
  const seen = new Set<string>();
  const endpoints: RpcEndpoint[] = [];

  for (const label of vars) {
    const raw = env[label]?.trim();
    if (!raw) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    endpoints.push({ label, host: hostOf(raw), url: raw, priority: endpoints.length });
  }
  return endpoints;
}

export function resolveHttpEndpoints(env: NodeJS.ProcessEnv = process.env): RpcEndpoint[] {
  return resolveEndpoints(HTTP_ENDPOINT_VARS, env);
}

export function resolveWsEndpoints(env: NodeJS.ProcessEnv = process.env): RpcEndpoint[] {
  return resolveEndpoints(WS_ENDPOINT_VARS, env);
}

/** Redact a URL for logs: host is kept, everything identifying is not. */
export function sanitizeUrl(url: string): string {
  return hostOf(url);
}

/**
 * Strip full RPC URLs out of free text, leaving the host.
 *
 * Provider errors embed the request URL, and that URL carries the API key. viem's error
 * messages are verbose and get copied into `reason`/`detail`, which the API returns to
 * browsers — so an un-redacted provider error publishes the key. Observed in the wild:
 * a 429 detail contained `https://<host>/v2/<key>` in a public API response.
 *
 * Redacts any http(s)/ws(s) URL with a path, since the key lives in the path or query.
 */
export function redactRpcUrls(text: string): string {
  if (!text) return text;
  return text.replace(/\b(https?|wss?):\/\/([^\s/"']+)(\/[^\s"']*)?/gi, (_match, scheme, host, path) =>
    path && path !== "/" ? `${scheme}://${host}/[redacted]` : `${scheme}://${host}`
  );
}

const QUOTA_PATTERNS = [
  /monthly capacity limit/i,
  /capacity limit exceeded/i,
  /quota/i,
  /exceeded.*compute units/i,
  /upgrade your (plan|scaling policy)/i,
];

const RATE_LIMIT_PATTERNS = [/rate limit/i, /too many requests/i, /throttl/i];

/**
 * A CDN bot shield answering instead of the node. Observed 2026-09-19: Cloudflare in
 * front of `rpc-robinhood.blockmachine.io` returned `HTTP 403` with the `text/plain`
 * body `error code: 1010` to requests that carried no `User-Agent` header.
 *
 * This must not be read as a dead key. The endpoint and the credential are both healthy;
 * the request never reached the node. Misfiled as QUOTA_EXHAUSTED it earned a 30-minute
 * cooldown on the only endpoint able to serve wide `eth_getLogs` ranges, which is how
 * Pons ingestion came to look like a provider-capacity problem (§28).
 */
const BOT_CHALLENGE_PATTERNS = [
  /error code: 10\d\d/i,
  /\bcf-mitigated\b/i,
  /just a moment/i,
  /attention required.*cloudflare/i,
  /checking your browser/i,
  /enable javascript and cookies to continue/i,
];

/**
 * Provider plans that cap eth_getLogs block ranges. Observed 2026-09-15 on Robinhood Chain's
 * Alchemy free tier (JSON-RPC -32600): "Under the Free tier plan, you can make eth_getLogs
 * requests with up to a 10 block range." Other providers word it as a maximum range or a
 * result-count cap. Kept narrow: a generic "invalid parameters" is not proof of a range cap.
 */
const RANGE_LIMIT_PATTERNS = [
  /eth_getLogs requests with up to a \d+ block range/i,
  /block range (is )?(too (large|wide)|exceeds|limit)/i,
  /(max(imum)?|exceed(s|ed)?) (the )?(allowed )?block range/i,
  /query returned more than \d+ results/i,
  /log response size exceeded/i,
  /**
   * Phase 7D.5 — the size cap can also be enforced by the *client*. A topic-only
   * `eth_getLogs` over 10,000 blocks of Pons curve trades returns ~10.5 MB and viem
   * refuses it with "HTTP response body exceeded the size limit. Max: 10485760 bytes".
   * That is the window being too wide, and nothing at all to do with endpoint health:
   * classified as CONNECTION it cooled down the one endpoint able to serve wide ranges,
   * while the listener kept the window and retried the same oversized request.
   */
  /response body exceeded the size limit/i,
  /response size (limit )?exceeded/i,
];

/**
 * Faults that belong to the request, not the endpoint. These must never trigger failover:
 * a revert reverts everywhere, and treating it as an outage would burn through every
 * provider and hide the real error.
 */
const REQUEST_FAULT_PATTERNS = [
  /execution reverted/i,
  /invalid params/i,
  /method not found/i,
  /method .* not supported/i,
  /unsupported method/i,
  // geth/erigon's wording for an unimplemented method — "the method debug_traceCall
  // does not exist/is not available". Missing this class is expensive: the call would
  // fail over across every provider for a method none of them implement.
  /does not exist\/is not available/i,
  /is not available/i,
  /invalid argument/i,
  /out of gas/i,
];

export interface ClassifyInput {
  status?: number;
  message?: string;
  /** `Retry-After` header, seconds or HTTP-date. */
  retryAfter?: string | null;
  code?: string;
}

/**
 * Classify a failure. Order matters: a 429 carrying a monthly-quota message is a quota
 * exhaustion, not a transient throttle, and the two get very different cooldowns.
 */
/**
 * Does this message say the provider refused the *block range* (as opposed to being
 * throttled, sick, or unreachable)?
 *
 * Exported so the adaptive log windows in the listeners narrow on exactly the same
 * evidence the failover classifier uses. Phase 7D.5: `curveTradeListener` previously kept
 * its own, much looser test that counted a bare "Request failed" as a range problem, so
 * any transport hiccup halved the window; it collapsed to the 10-block floor and stayed
 * there, which is why curve-trade ingestion ran at ~35 blocks/s against a 6.3M backlog.
 */
export function isRangeLimitMessage(message: string): boolean {
  return RANGE_LIMIT_PATTERNS.some((p) => p.test(message));
}

export function classifyRpcFailure(input: ClassifyInput): RpcFailureClass {
  const message = input.message ?? "";

  if (isRangeLimitMessage(message)) return "RANGE_LIMIT";
  if (REQUEST_FAULT_PATTERNS.some((p) => p.test(message))) return "REQUEST_FAULT";
  if (QUOTA_PATTERNS.some((p) => p.test(message))) return "QUOTA_EXHAUSTED";

  if (input.status === 429 || RATE_LIMIT_PATTERNS.some((p) => p.test(message))) {
    return "RATE_LIMITED";
  }
  if (input.status === 402) return "QUOTA_EXHAUSTED";
  // A 403 that carries a bot-shield fingerprint is about the request, not the key — keep
  // it separate so a healthy endpoint is not parked for 30 minutes. Checked before the
  // generic 401/403 rule below, which still owns a plain "Forbidden" (a revoked key).
  if (BOT_CHALLENGE_PATTERNS.some((p) => p.test(message))) return "BOT_CHALLENGE";
  // 401/403 usually mean a bad or exhausted key. Treated as quota-like: a long cooldown,
  // because retrying in 10s will fail identically.
  if (input.status === 401 || input.status === 403) return "QUOTA_EXHAUSTED";
  if (input.status !== undefined && input.status >= 500) return "SERVER_ERROR";

  if (input.code === "ETIMEDOUT" || /timeout|timed out/i.test(message)) return "TIMEOUT";
  if (
    input.code === "ECONNREFUSED" ||
    input.code === "ECONNRESET" ||
    input.code === "ENOTFOUND" ||
    /fetch failed|socket hang up|network/i.test(message)
  ) {
    return "CONNECTION";
  }
  return "CONNECTION";
}

/** Parse `Retry-After` (delta-seconds or HTTP-date) into ms. Null when absent/unusable. */
export function parseRetryAfterMs(retryAfter: string | null | undefined, now = Date.now()): number | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

/** Full jitter: delay is uniform in [0, capped), which avoids synchronized retry storms. */
export function backoffWithJitter(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random
): number {
  const capped = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * capped);
}

/** Per-endpoint health, tracked by the failover client and exposed as sanitized metrics. */
export interface EndpointHealth {
  label: string;
  host: string;
  priority: number;
  healthy: boolean;
  cooldownUntil: number | null;
  lastFailure: RpcFailureClass | null;
  consecutiveFailures: number;
  successCount: number;
  failureCount: number;
  failoverCount: number;
  lastUsedAt: number | null;
  observedChainId: number | null;
}

export function isInCooldown(health: EndpointHealth, now = Date.now()): boolean {
  return health.cooldownUntil !== null && health.cooldownUntil > now;
}

/**
 * Cooldown for a failure, honouring `Retry-After` when the provider sent one.
 *
 * Deliberately takes the longer of the two: a provider asking for 60s during a
 * monthly-quota outage is still not going to serve anything useful in 60s.
 */
export function cooldownFor(
  failure: RpcFailureClass,
  retryAfterMs: number | null,
  consecutiveFailures: number
): number {
  const base = COOLDOWN_MS[failure];
  if (base === 0) return 0;

  // Escalate repeat offenders, capped, so a persistently broken endpoint is not retried
  // as eagerly as one that blipped once.
  const escalated = Math.min(base * Math.max(1, consecutiveFailures), base * 8);
  return retryAfterMs === null ? escalated : Math.max(escalated, retryAfterMs);
}
