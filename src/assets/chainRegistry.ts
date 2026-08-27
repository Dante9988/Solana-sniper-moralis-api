import { SupportedChain } from "./types";

export interface ChainDefinition {
  chain: SupportedChain;
  chainId: string;
  addressFormat: "SOLANA_PUBLIC_KEY" | "EVM_20_BYTE_HEX";
}

export const CHAIN_REGISTRY: Readonly<Record<SupportedChain, Readonly<ChainDefinition>>> = Object.freeze({
  SOLANA: Object.freeze({ chain: "SOLANA", chainId: "solana-mainnet", addressFormat: "SOLANA_PUBLIC_KEY" }),
  ETHEREUM: Object.freeze({ chain: "ETHEREUM", chainId: "1", addressFormat: "EVM_20_BYTE_HEX" }),
  BNB_SMART_CHAIN: Object.freeze({ chain: "BNB_SMART_CHAIN", chainId: "56", addressFormat: "EVM_20_BYTE_HEX" }),
});

export const SUPPORTED_CHAINS = Object.freeze(Object.keys(CHAIN_REGISTRY) as SupportedChain[]);

export function isSupportedChain(value: string): value is SupportedChain {
  return Object.prototype.hasOwnProperty.call(CHAIN_REGISTRY, value);
}
