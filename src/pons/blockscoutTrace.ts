/**
 * Phase 7D §1 (metadata) — best-effort fallback for the (uncommon) case
 * where a launch transaction's top-level call isn't `launchToken`/
 * `launchTokenFor` directly (routed through a bundler/router instead, as
 * the example transaction was — see abiV2.ts's header for the full
 * verification trail).
 *
 * `raw-trace` is a Blockscout-specific endpoint, not a standard JSON-RPC
 * method — it has been flaky throughout this repo's own verification work
 * this session (frequent 500s, no 429s ever observed — i.e. not classic
 * rate-limiting). `BLOCKSCOUT_API_KEY` (optional) was spot-checked
 * side-by-side against several list-style endpoints: a small but real
 * improvement (e.g. 2/4 vs 0/4, 1/4 vs 0/4 successes across a handful of
 * back-to-back requests), not a fix — the instability looks structural to
 * this Blockscout deployment's heavier routes, not solely auth/rate-limit
 * gated. Sent as `x-api-key` (the header this deployment actually
 * responded to in testing — no documented convention was found for this
 * key format). A few retries with backoff is what actually moves the
 * needle at ~50% single-shot failure — 3 attempts gets real-world hit rate
 * to ~87%. This module stays deliberately isolated and fail-soft either
 * way: every failure mode returns `null`, never throws, and
 * discoveryV2Listener.ts must never block discovery on it. This is a
 * secondary path — the primary path is decoding the transaction's own
 * top-level input directly via ChainReader.getTransaction (no Blockscout
 * dependency at all).
 */

const REQUEST_TIMEOUT_MS = 8_000;
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TraceCallNode {
  readonly to?: string;
  readonly input?: string;
  readonly calls?: readonly TraceCallNode[];
}

/**
 * Walks a Blockscout raw-trace call tree looking for the first call whose
 * `to` matches `targetAddress` and whose `input` starts with one of
 * `selectors`. Returns that call's raw input, or null if the trace
 * couldn't be fetched/parsed or no matching call exists.
 */
export async function findMatchingInternalCallInput(params: {
  explorerBaseUrl: string;
  txHash: string;
  targetAddress: string;
  selectors: readonly string[];
}): Promise<string | null> {
  const target = params.targetAddress.toLowerCase();
  const selectors = new Set(params.selectors.map((s) => s.toLowerCase()));

  let root: TraceCallNode | null = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && root === null; attempt += 1) {
    if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const apiKey = process.env.BLOCKSCOUT_API_KEY;
      const response = await fetch(`${params.explorerBaseUrl.replace(/\/+$/, "")}/api/v2/transactions/${params.txHash}/raw-trace`, {
        signal: controller.signal,
        headers: {
          // Blockscout's Cloudflare front-end has returned bare error pages
          // to non-browser-looking User-Agents during this repo's own
          // verification work — matched, not spoofed maliciously; this is
          // read-only public block-explorer data.
          "User-Agent": "Mozilla/5.0 (compatible; OnlyPumpBackend/1.0)",
          ...(apiKey ? { "x-api-key": apiKey } : {}),
        },
      });
      clearTimeout(timeout);
      if (!response.ok) continue;
      root = (await response.json()) as TraceCallNode;
    } catch {
      continue;
    }
  }
  if (root === null) return null;

  const stack: TraceCallNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.to?.toLowerCase() === target && node.input && selectors.has(node.input.slice(0, 10).toLowerCase())) {
      return node.input;
    }
    if (node.calls) stack.push(...node.calls);
  }
  return null;
}
