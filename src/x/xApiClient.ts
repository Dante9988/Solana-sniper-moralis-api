/**
 * Phase X — read-only X API client, capability checkpoint only.
 *
 * This file makes exactly one kind of request: a single, non-retried
 * `GET {baseUrl}/tweets/search/stream/rules?max_results=1` with a Bearer
 * token. It never creates/replaces/deletes rules, never opens the
 * persistent filtered-stream connection, never retries automatically, and
 * never touches PostgreSQL, Anthropic, Discord, forensics, or any
 * wallet/signer/transaction/swap/trading code — none of that is imported
 * here or reachable from this module.
 *
 * The Authorization header is used only as a fetch request header. It is
 * never included in a returned result, a thrown/caught error, or a log
 * line — every error path below goes through `sanitizeReason`, which also
 * strips any URL (in case a network error ever echoes the request URL).
 */

import { z } from "zod";
import { XConfig } from "./config";
import { XClientFailureCode, XRateLimitInfo, XStreamRulesCheckResult } from "./types";

const MAX_RESPONSE_BYTES = 64 * 1024;

/** Deliberately lenient: only what this checkpoint needs (count + presence), never rule content shape. */
const StreamRulesResponseSchema = z
  .object({
    data: z.array(z.unknown()).optional(),
    meta: z.unknown().optional(),
  })
  .passthrough();

function sanitizeReason(message: string): string {
  return message
    .replace(/https?:\/\/[^\s"']+/gi, "[redacted-url]")
    .replace(/bearer\s+\S+/gi, "bearer [redacted]")
    .slice(0, 500);
}

function mapHttpStatus(status: number): { code: XClientFailureCode; reason: string } {
  if (status === 401) return { code: "AUTHENTICATION_FAILED", reason: "HTTP 401: authentication failed" };
  if (status === 403) return { code: "ACCESS_DENIED", reason: "HTTP 403: access denied" };
  if (status === 429) return { code: "RATE_LIMITED", reason: "HTTP 429: rate limited" };
  if (status >= 500 && status < 600) return { code: "SERVER_ERROR", reason: `HTTP ${status}: server error` };
  return { code: "UNEXPECTED_STATUS", reason: `HTTP ${status}: unexpected response` };
}

function parseIntHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractRateLimit(headers: Headers): XRateLimitInfo | undefined {
  const limit = parseIntHeader(headers.get("x-rate-limit-limit"));
  const remaining = parseIntHeader(headers.get("x-rate-limit-remaining"));
  const resetEpochSeconds = parseIntHeader(headers.get("x-rate-limit-reset"));
  if (limit === undefined && remaining === undefined && resetEpochSeconds === undefined) return undefined;
  return { limit, remaining, resetEpochSeconds };
}

export interface XApiClientOptions {
  config: XConfig;
  /** Injectable for tests. Defaults to global `fetch`. Never called with any method other than this checkpoint's single GET. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  now?: () => Date;
}

export class XApiClient {
  private readonly config: XConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(options: XApiClientOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * The ONLY method on this client. Exactly one non-retried GET request to
   * the stream-rules read endpoint — never creates, replaces, or deletes a
   * rule, and never opens the persistent stream.
   */
  async checkStreamRulesAccess(): Promise<XStreamRulesCheckResult> {
    const startedAt = this.now();

    if (!this.config.bearerToken) {
      return this.failure("NOT_CONFIGURED", "X_BEARER_TOKEN is not configured", undefined, undefined, startedAt);
    }

    const url = `${this.config.baseUrl}/tweets/search/stream/rules?max_results=1`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.config.bearerToken}` },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        return this.failure("TIMEOUT", "request timed out", undefined, undefined, startedAt);
      }
      return this.failure(
        "NETWORK_ERROR",
        sanitizeReason(err instanceof Error ? err.message : "network request failed"),
        undefined,
        undefined,
        startedAt
      );
    }
    clearTimeout(timer);

    const rateLimit = extractRateLimit(res.headers);

    const contentLength = res.headers.get("content-length");
    if (contentLength && Number(contentLength) > MAX_RESPONSE_BYTES) {
      return this.failure("RESPONSE_TOO_LARGE", "response exceeded the configured size limit", res.status, rateLimit, startedAt);
    }

    if (!res.ok) {
      const mapped = mapHttpStatus(res.status);
      return this.failure(mapped.code, mapped.reason, res.status, rateLimit, startedAt);
    }

    let text: string;
    try {
      text = await res.text();
    } catch {
      return this.failure("NETWORK_ERROR", "failed to read response body", res.status, rateLimit, startedAt);
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      return this.failure("RESPONSE_TOO_LARGE", "response exceeded the configured size limit", res.status, rateLimit, startedAt);
    }

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return this.failure("INVALID_RESPONSE", "response was not valid JSON", res.status, rateLimit, startedAt);
    }

    const parsed = StreamRulesResponseSchema.safeParse(json);
    if (!parsed.success) {
      return this.failure("INVALID_RESPONSE", "response failed schema validation", res.status, rateLimit, startedAt);
    }

    const completedAt = this.now();
    return {
      status: "SUCCESS",
      httpStatus: res.status,
      ruleCount: parsed.data.data?.length ?? 0,
      hasMeta: parsed.data.meta !== undefined,
      rateLimit,
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      completedAtUtc: completedAt.toISOString(),
    };
  }

  private failure(
    code: XClientFailureCode,
    reason: string,
    httpStatus: number | undefined,
    rateLimit: XRateLimitInfo | undefined,
    startedAt: Date
  ): XStreamRulesCheckResult {
    const completedAt = this.now();
    return {
      status: "FAILURE",
      code,
      httpStatus,
      reason: sanitizeReason(reason),
      rateLimit,
      latencyMs: completedAt.getTime() - startedAt.getTime(),
      completedAtUtc: completedAt.toISOString(),
    };
  }
}
