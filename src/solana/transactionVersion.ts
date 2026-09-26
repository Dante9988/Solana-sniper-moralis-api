/**
 * Phase 7E.4.3 §0 — one place that decides which Solana transaction versions we can read.
 *
 * Mainnet now returns version-1 transactions. Every reader in this repository was pinned to
 * `maxSupportedTransactionVersion: 0`, and the RPC does not degrade gracefully for those —
 * it refuses the whole request:
 *
 *   {"code":-32015,"message":"Transaction version (1) is not supported by the requesting
 *    client. Please try the request again with the following configuration parameter..."}
 *
 * Observed directly against mainnet on 2026-09-26 while decoding live Pump.fun activity.
 *
 * That distinction is the reason this module exists rather than four edited literals: a
 * version we cannot read must fail **visibly**, because a listener that treats the error as
 * "nothing here" would drop real trades and look perfectly healthy while doing it.
 */

/**
 * The highest transaction version this codebase can parse.
 *
 * Raise it only alongside evidence that the decoders handle the new shape. `getTransaction`
 * returns an error, not an empty result, for anything above it, so raising this blindly would
 * turn a loud failure into a silent misparse.
 */
export const SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION = 1;

/** RPC error code for "this client cannot read that transaction version". */
export const UNSUPPORTED_TRANSACTION_VERSION_CODE = -32015;

export interface GetTransactionConfig {
  encoding?: "json" | "jsonParsed" | "base64";
  commitment?: "processed" | "confirmed" | "finalized";
  maxSupportedTransactionVersion: number;
}

/**
 * Config for `getTransaction`, with the version already correct.
 *
 * Callers pass what they care about — encoding, commitment — and never the version, so a new
 * reader cannot reintroduce the bug by forgetting it.
 */
export function getTransactionConfig(
  options: { encoding?: GetTransactionConfig["encoding"]; commitment?: GetTransactionConfig["commitment"] } = {}
): GetTransactionConfig {
  return {
    ...(options.encoding ? { encoding: options.encoding } : {}),
    ...(options.commitment ? { commitment: options.commitment } : {}),
    maxSupportedTransactionVersion: SOLANA_MAX_SUPPORTED_TRANSACTION_VERSION,
  };
}

/**
 * True when an RPC error means "this transaction is a version we cannot read".
 *
 * Callers must surface this as its own outcome — an `unsupportedTxVersion` counter — rather
 * than folding it into a generic failure or, worse, a skip. It is the signal that the
 * constant above has fallen behind the chain.
 */
export function isUnsupportedTransactionVersion(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code === UNSUPPORTED_TRANSACTION_VERSION_CODE) return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && /transaction version \(\d+\) is not supported/i.test(message);
}
