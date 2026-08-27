/**
 * Phase X — typed result for the single read-only X capability checkpoint
 * (`GET /2/tweets/search/stream/rules?max_results=1`). No rule content,
 * account names, headers, or credentials belong on this type — only what is
 * explicitly safe to print (phaseX.txt "Safe smoke-test output").
 */

export type XClientFailureCode =
  | "NOT_CONFIGURED"
  | "AUTHENTICATION_FAILED" // HTTP 401
  | "ACCESS_DENIED" // HTTP 403
  | "RATE_LIMITED" // HTTP 429
  | "SERVER_ERROR" // HTTP 5xx
  | "UNEXPECTED_STATUS" // any other non-2xx
  | "TIMEOUT"
  | "INVALID_RESPONSE" // malformed JSON / failed schema validation
  | "RESPONSE_TOO_LARGE"
  | "NETWORK_ERROR";

/** Only the rate-limit headers the X API documents as safe to surface — never a full header dump. */
export interface XRateLimitInfo {
  limit?: number;
  remaining?: number;
  resetEpochSeconds?: number;
}

export interface XStreamRulesCheckSuccess {
  status: "SUCCESS";
  httpStatus: number;
  /** Count only — never the rule values or tags themselves. */
  ruleCount: number;
  hasMeta: boolean;
  rateLimit?: XRateLimitInfo;
  latencyMs: number;
  completedAtUtc: string;
}

export interface XStreamRulesCheckFailure {
  status: "FAILURE";
  code: XClientFailureCode;
  httpStatus?: number;
  /** Already sanitized — never contains a URL, header value, or the bearer token. */
  reason: string;
  rateLimit?: XRateLimitInfo;
  latencyMs: number;
  completedAtUtc: string;
}

export type XStreamRulesCheckResult = XStreamRulesCheckSuccess | XStreamRulesCheckFailure;
