import { PublicKey } from "@solana/web3.js";
import { CHAIN_REGISTRY, isSupportedChain } from "./chainRegistry";
import { AssetIdentity, AssetResolutionInput, AssetResolutionResult, SupportedChain } from "./types";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_CHAINS: SupportedChain[] = ["ETHEREUM", "BNB_SMART_CHAIN"];

function resolveForChain(
  address: string,
  chain: SupportedChain,
  metadata: Pick<AssetResolutionInput, "symbol" | "name">
): AssetResolutionResult {
  const definition = CHAIN_REGISTRY[chain];
  let normalizedAddress: string;

  if (definition.addressFormat === "SOLANA_PUBLIC_KEY") {
    if (address.startsWith("0x")) return { status: "INVALID_ADDRESS", reason: "EVM address is incompatible with SOLANA" };
    try {
      normalizedAddress = new PublicKey(address).toBase58();
    } catch {
      return { status: "INVALID_ADDRESS", reason: "Invalid Solana public key" };
    }
  } else {
    if (!EVM_ADDRESS.test(address)) {
      return { status: "INVALID_ADDRESS", reason: `Address is not a valid 20-byte hexadecimal address for ${chain}` };
    }
    normalizedAddress = address.toLowerCase();
  }

  const asset: AssetIdentity = {
    chain,
    chainId: definition.chainId,
    address,
    normalizedAddress,
    ...(metadata.symbol === undefined ? {} : { symbol: metadata.symbol }),
    ...(metadata.name === undefined ? {} : { name: metadata.name }),
  };
  return { status: "RESOLVED", asset };
}

export function resolveAsset(input: AssetResolutionInput): AssetResolutionResult {
  const address = typeof input.address === "string" ? input.address.trim() : "";
  if (!address) return { status: "INVALID_ADDRESS", reason: "Address is required" };

  if (input.chain !== undefined) {
    if (typeof input.chain !== "string" || !isSupportedChain(input.chain)) {
      return { status: "UNSUPPORTED_CHAIN", reason: `Unsupported chain: ${String(input.chain)}` };
    }
    return resolveForChain(address, input.chain, input);
  }

  if (EVM_ADDRESS.test(address)) {
    return { status: "AMBIGUOUS_CHAIN", inputAddress: address, candidateChains: [...EVM_CHAINS] };
  }
  if (address.startsWith("0x")) {
    return { status: "INVALID_ADDRESS", reason: "Malformed EVM address" };
  }
  return resolveForChain(address, "SOLANA", input);
}

export function canonicalAssetKey(asset: Pick<AssetIdentity, "chainId" | "normalizedAddress">): string {
  return `${asset.chainId}:${asset.normalizedAddress}`;
}
