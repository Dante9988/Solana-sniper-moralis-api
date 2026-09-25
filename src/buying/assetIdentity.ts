/**
 * Phase 7D.5.1 — canonical asset identity.
 *
 * The rule this file exists to enforce: **a symbol or a CoinGecko id never authorizes a
 * purchase.** "BTC" is not an asset — native Bitcoin, WBTC on Ethereum and a bridged
 * wrapper on some L2 are three different things with different custody, different networks
 * and different risk, and a buy flow that treats them as one will eventually deliver the
 * wrong one. An asset here is a network plus an on-chain identity, and nothing less.
 *
 * `kind` also carries what the thing *is*, because a tokenized equity is not a share and an
 * equity-linked perp is neither. That distinction has to survive all the way to checkout.
 */

export type AssetNetwork = "solana" | "ethereum" | "robinhood" | "bitcoin";

export type AssetKind =
  /** The network's own gas token. */
  | "native"
  /** An ordinary fungible token on that network. */
  | "token"
  /** A token that represents an asset held elsewhere — WBTC, and anything bridged. */
  | "wrapped"
  /** A token tracking an equity's price. Not a share, and carries no shareholder rights. */
  | "tokenized_equity"
  /** A perpetual futures market. Not ownership of anything. */
  | "perp";

export interface AssetIdentity {
  readonly network: AssetNetwork;
  readonly kind: AssetKind;
  /**
   * The on-chain identity: EVM contract address, Solana mint, or `null` for a network's
   * native coin (which has no contract). Lowercased for EVM; Solana mints are
   * case-sensitive base58 and are left alone.
   */
  readonly address: string | null;
  readonly decimals: number;
  /** Display only. Never used to resolve or authorize anything. */
  readonly symbol: string;
  readonly name: string;
  /**
   * What this token represents when it is not itself. `wrapped` and `tokenized_equity`
   * must set it, because it is the disclosure the user needs before approving.
   */
  readonly represents?: {
    readonly what: string;
    /** Plain language, shown at checkout — not a tooltip. */
    readonly disclosure: string;
  };
}

export class AssetIdentityError extends Error {}

const EVM_NETWORKS: ReadonlySet<AssetNetwork> = new Set(["ethereum", "robinhood"]);
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
/** Base58, 32-byte pubkey. Deliberately not a loose length check. */
const SOLANA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * A stable key for caching, comparison and idempotency. Network first, so two assets can
 * never collide across chains — the exact failure this whole module prevents.
 */
export function assetKey(asset: AssetIdentity): string {
  return `${asset.network}:${asset.address ?? "native"}`;
}

export function sameAsset(a: AssetIdentity, b: AssetIdentity): boolean {
  return assetKey(a) === assetKey(b);
}

/**
 * Validate an identity, normalising EVM addresses to lowercase.
 *
 * Fails closed: an address that does not match its network's format is refused rather than
 * passed downstream, because by the time a malformed mint reaches a swap it has already
 * been shown to the user as a real asset.
 */
export function normalizeAsset(asset: AssetIdentity): AssetIdentity {
  if (!Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 36) {
    throw new AssetIdentityError(`${asset.symbol}: decimals must be an integer in 0..36, got ${asset.decimals}`);
  }

  if (asset.kind === "native") {
    if (asset.address !== null) throw new AssetIdentityError(`${asset.symbol}: a native asset has no contract address`);
    return asset;
  }

  if (asset.address === null) {
    throw new AssetIdentityError(`${asset.symbol}: a non-native asset must carry its on-chain address`);
  }

  if (EVM_NETWORKS.has(asset.network)) {
    const lowered = asset.address.toLowerCase();
    if (!EVM_ADDRESS.test(lowered)) {
      throw new AssetIdentityError(`${asset.symbol}: ${asset.address} is not an address on ${asset.network}`);
    }
    return { ...asset, address: lowered };
  }

  if (asset.network === "solana") {
    if (!SOLANA_MINT.test(asset.address)) {
      throw new AssetIdentityError(`${asset.symbol}: ${asset.address} is not a Solana mint`);
    }
    return asset;
  }

  throw new AssetIdentityError(`${asset.symbol}: ${asset.network} has no token model, so it cannot hold ${asset.kind}`);
}

/**
 * The disclosure a purchase screen must show for this asset, or null when the asset is
 * exactly what its symbol says.
 *
 * Returned as data rather than rendered text so the same sentence appears on web, mobile and
 * in any confirmation the backend sends — one wording, one place to review it.
 */
export function purchaseDisclosure(asset: AssetIdentity): string | null {
  switch (asset.kind) {
    case "wrapped":
      return (
        asset.represents?.disclosure ??
        `${asset.symbol} is a wrapped token on ${networkLabel(asset.network)}, not the native asset it tracks.`
      );
    case "tokenized_equity":
      return (
        asset.represents?.disclosure ??
        `${asset.symbol} is a tokenized equity on ${networkLabel(asset.network)}. It tracks a share price; it is not a share and carries no shareholder rights.`
      );
    case "perp":
      return `${asset.symbol} is a perpetual futures market, not ownership of the underlying asset.`;
    default:
      return null;
  }
}

export function networkLabel(network: AssetNetwork): string {
  switch (network) {
    case "solana":
      return "Solana";
    case "ethereum":
      return "Ethereum";
    case "robinhood":
      return "Robinhood Chain";
    case "bitcoin":
      return "Bitcoin";
  }
}

/**
 * Canonical WBTC on Ethereum.
 *
 * Named explicitly rather than looked up by the symbol "BTC", because that substitution is
 * precisely what the brief forbids.
 *
 * **The address below is NOT yet verified on-chain from this environment.** The Ethereum
 * RPC key returns 429 and the public endpoints reachable here are gated, so `symbol()`,
 * `decimals()` and the deployed bytecode could not be read on 2026-09-20. It is recorded in
 * `docs/phase-7d5-1/source-matrix.md` as unverified, and no WBTC route is exposed to a user
 * until it is — an asset identity nobody has checked is exactly the way the wrong token
 * gets delivered.
 */
export const WBTC_ETHEREUM: AssetIdentity = Object.freeze({
  network: "ethereum",
  kind: "wrapped",
  address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599",
  decimals: 8,
  symbol: "WBTC",
  name: "Wrapped Bitcoin",
  represents: {
    what: "Bitcoin held by a custodian",
    disclosure:
      "Wrapped Bitcoin (WBTC) on Ethereum. This is an ERC-20 backed by custodied BTC — not native Bitcoin, and it does not settle on the Bitcoin network.",
  },
});

/** Native Bitcoin, kept as a separate asset so it can never be silently served as WBTC. */
export const NATIVE_BTC: AssetIdentity = Object.freeze({
  network: "bitcoin",
  kind: "native",
  address: null,
  decimals: 8,
  symbol: "BTC",
  name: "Bitcoin",
});
