import { TokenDiscoveryEvent } from "../intelligence/types";
import { resolveAsset } from "./assetResolver";
import { AssetResolutionResult } from "./types";

/** Current discovery events explicitly carry Solana mints; source is not a chain hint. */
export function resolveTokenDiscoveryAsset(event: TokenDiscoveryEvent): AssetResolutionResult {
  return resolveAsset({ address: event.mint, chain: "SOLANA" });
}
