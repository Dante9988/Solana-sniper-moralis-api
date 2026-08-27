/**
 * Phase 5A/5B versioned, validated forensics configuration.
 * Approved defaults per phase4-5.txt §§4, 6, 10 and hardened per phase5b.txt §§1–2.
 */

export class ForensicsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForensicsConfigError";
  }
}

/**
 * The only hard exclusion threshold approved in Phase 5. This is a fixed
 * application constant, never read from the environment. No environment
 * variable can raise it, disable it, set it to NaN/Infinity, change the
 * `>=` comparison in `tokenEligibilityPolicy.ts`, or bypass evaluation of
 * either mandatory bundle metric — none of those code paths consult `process.env`.
 */
export const MANDATORY_BUNDLE_EXCLUSION_PCT = 40 as const;

/** Bump on any threshold/rule change so persisted assessments remain attributable. */
export const FORENSICS_POLICY_VERSION = "phase5b.2026-08-25";

function parseValidatedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  opts: { min?: number } = {}
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ForensicsConfigError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new ForensicsConfigError(`${name} must be a safe integer, got ${trimmed}`);
  }
  const min = opts.min ?? 1;
  if (parsed < min) {
    throw new ForensicsConfigError(`${name} must be >= ${min}, got ${parsed}`);
  }
  return parsed;
}

function parseValidatedPercentage(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new ForensicsConfigError(`${name} must be a finite number, got ${JSON.stringify(raw)}`);
  }
  if (parsed < 0 || parsed > 100) {
    throw new ForensicsConfigError(`${name} must be within 0-100, got ${parsed}`);
  }
  return parsed;
}

function parseStrictBool(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  throw new ForensicsConfigError(`${name} must be exactly "true" or "false", got ${JSON.stringify(raw)}`);
}

export interface ForensicsCautionThresholds {
  readonly bundledSupplyPct: number;
  readonly developerClusterHoldingsPct: number;
  readonly adjustedTop10HoldingsPct: number;
  readonly insiderClusterHoldingsPct: number;
  readonly sniperHoldingsPct: number;
  readonly boundedFreshWalletHoldingsPct: number;
}

export interface ResolvedForensicsConfig {
  readonly policyVersion: string;
  readonly mandatoryBundleExclusionPct: 40;
  readonly launchWindowSlots: number;
  readonly sniperWindowSlots: number;
  readonly fundingLookbackDepth: number;
  readonly freshWalletLookbackDays: number;
  readonly maxHolderPagesFast: number;
  readonly maxHolderPagesDeep: number;
  readonly maxTransactionsFast: number;
  readonly maxTransactionsDeep: number;
  readonly maxWalletsFast: number;
  readonly maxWalletsDeep: number;
  readonly fastForensicsMaxCreditsPerToken: number;
  readonly deepForensicsMaxCreditsPerToken: number;
  readonly deepForensicsEnabled: boolean;
  readonly cautionThresholds: ForensicsCautionThresholds;
  readonly freshWalletDefinitionLabel: string;
}

/**
 * Parses and validates every Phase 5 operational/CAUTION knob from `env`.
 * Fails closed: a present-but-invalid value throws `ForensicsConfigError`
 * rather than silently falling back to a default or converting to zero. Never
 * reads `MANDATORY_BUNDLE_EXCLUSION_PCT` from the environment — that constant
 * is fixed above and is not part of this function or its return value's
 * effect on eligibility (CAUTION thresholds can only ever produce `CAUTION`,
 * never bypass or relax the hard exclusion).
 */
export function loadForensicsConfig(env: NodeJS.ProcessEnv = process.env): ResolvedForensicsConfig {
  const launchWindowSlots = parseValidatedInt(env, "LAUNCH_WINDOW_SLOTS", 5);
  const sniperWindowSlots = parseValidatedInt(env, "SNIPER_WINDOW_SLOTS", 20);
  const fundingLookbackDepth = parseValidatedInt(env, "FUNDING_LOOKBACK_DEPTH", 1);
  const freshWalletLookbackDays = parseValidatedInt(env, "FRESH_WALLET_LOOKBACK_DAYS", 30);
  const maxHolderPagesFast = parseValidatedInt(env, "MAX_HOLDER_PAGES_FAST", 2);
  const maxHolderPagesDeep = parseValidatedInt(env, "MAX_HOLDER_PAGES_DEEP", 20);
  const maxTransactionsFast = parseValidatedInt(env, "MAX_TRANSACTIONS_FAST", 25);
  const maxTransactionsDeep = parseValidatedInt(env, "MAX_TRANSACTIONS_DEEP", 250);
  const maxWalletsFast = parseValidatedInt(env, "MAX_WALLETS_FAST", 10);
  const maxWalletsDeep = parseValidatedInt(env, "MAX_WALLETS_DEEP", 50);
  const fastForensicsMaxCreditsPerToken = parseValidatedInt(
    env,
    "FAST_FORENSICS_MAX_CREDITS_PER_TOKEN",
    75
  );
  const deepForensicsMaxCreditsPerToken = parseValidatedInt(
    env,
    "DEEP_FORENSICS_MAX_CREDITS_PER_TOKEN",
    300
  );
  const deepForensicsEnabled = parseStrictBool(env, "DEEP_FORENSICS_ENABLED", false);

  const cautionThresholds: ForensicsCautionThresholds = Object.freeze({
    bundledSupplyPct: parseValidatedPercentage(env, "CAUTION_BUNDLED_SUPPLY_PCT", 20),
    developerClusterHoldingsPct: parseValidatedPercentage(
      env,
      "CAUTION_DEVELOPER_CLUSTER_HOLDINGS_PCT",
      5
    ),
    adjustedTop10HoldingsPct: parseValidatedPercentage(env, "CAUTION_ADJUSTED_TOP10_HOLDINGS_PCT", 30),
    insiderClusterHoldingsPct: parseValidatedPercentage(
      env,
      "CAUTION_INSIDER_CLUSTER_HOLDINGS_PCT",
      15
    ),
    sniperHoldingsPct: parseValidatedPercentage(env, "CAUTION_SNIPER_HOLDINGS_PCT", 20),
    boundedFreshWalletHoldingsPct: parseValidatedPercentage(
      env,
      "CAUTION_BOUNDED_FRESH_WALLET_HOLDINGS_PCT",
      25
    ),
  });

  return Object.freeze({
    policyVersion: FORENSICS_POLICY_VERSION,
    mandatoryBundleExclusionPct: MANDATORY_BUNDLE_EXCLUSION_PCT,
    launchWindowSlots,
    sniperWindowSlots,
    fundingLookbackDepth,
    freshWalletLookbackDays,
    maxHolderPagesFast,
    maxHolderPagesDeep,
    maxTransactionsFast,
    maxTransactionsDeep,
    maxWalletsFast,
    maxWalletsDeep,
    fastForensicsMaxCreditsPerToken,
    deepForensicsMaxCreditsPerToken,
    deepForensicsEnabled,
    cautionThresholds,
    freshWalletDefinitionLabel: `NO_ACTIVITY_OBSERVED_IN_BOUNDED_${freshWalletLookbackDays}_DAY_LOOKBACK`,
  });
}

/**
 * Eagerly resolved at module load from real `process.env`. Fails closed
 * (throws, crashing the process rather than running with bad config) if any
 * configured value is invalid. This is the resolved policy configuration
 * snapshot required by phase5b.txt §2 — it contains no secrets, only numeric
 * and boolean policy knobs.
 */
export const RESOLVED_FORENSICS_CONFIG = loadForensicsConfig();

export const CAUTION_THRESHOLDS = RESOLVED_FORENSICS_CONFIG.cautionThresholds;
export const LAUNCH_WINDOW_SLOTS = RESOLVED_FORENSICS_CONFIG.launchWindowSlots;
export const SNIPER_WINDOW_SLOTS = RESOLVED_FORENSICS_CONFIG.sniperWindowSlots;
export const FUNDING_LOOKBACK_DEPTH = RESOLVED_FORENSICS_CONFIG.fundingLookbackDepth;
export const FRESH_WALLET_LOOKBACK_DAYS = RESOLVED_FORENSICS_CONFIG.freshWalletLookbackDays;
export const FRESH_WALLET_DEFINITION_LABEL = RESOLVED_FORENSICS_CONFIG.freshWalletDefinitionLabel;
export const MAX_HOLDER_PAGES_FAST = RESOLVED_FORENSICS_CONFIG.maxHolderPagesFast;
export const MAX_HOLDER_PAGES_DEEP = RESOLVED_FORENSICS_CONFIG.maxHolderPagesDeep;
export const MAX_TRANSACTIONS_FAST = RESOLVED_FORENSICS_CONFIG.maxTransactionsFast;
export const MAX_TRANSACTIONS_DEEP = RESOLVED_FORENSICS_CONFIG.maxTransactionsDeep;
export const MAX_WALLETS_FAST = RESOLVED_FORENSICS_CONFIG.maxWalletsFast;
export const MAX_WALLETS_DEEP = RESOLVED_FORENSICS_CONFIG.maxWalletsDeep;
export const FAST_FORENSICS_MAX_CREDITS_PER_TOKEN =
  RESOLVED_FORENSICS_CONFIG.fastForensicsMaxCreditsPerToken;
export const DEEP_FORENSICS_MAX_CREDITS_PER_TOKEN =
  RESOLVED_FORENSICS_CONFIG.deepForensicsMaxCreditsPerToken;
export const DEEP_FORENSICS_ENABLED = RESOLVED_FORENSICS_CONFIG.deepForensicsEnabled;
