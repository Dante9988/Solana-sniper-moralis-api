import { z } from "zod";
import { PublicKey } from "@solana/web3.js";
import type { MoonPayEnvironment } from "./config";

export const MoonPayCheckoutInputSchema = z.object({
  baseCurrencyCode: z.literal("usd"),
  baseCurrencyAmount: z.string().max(12).regex(/^\d+(\.\d{1,2})?$/)
    .refine((v) => BigInt(v.replace(".", "")) > 0n, "amount must be positive"),
  currencyCode: z.enum(["eth", "sol"]),
  walletAddress: z.string().min(26).max(64),
  network: z.enum(["ethereum", "ethereum-sepolia", "solana", "solana-devnet"]),
  redirectUrl: z.string().url().max(2048).optional(),
  idempotencyKey: z.string().min(8).max(200),
}).strict();

export class MoonPayInputError extends Error {}
export function expectedNetwork(currency: string, environment: MoonPayEnvironment): string | null {
  if (currency === "eth") return environment === "sandbox" ? "ethereum-sepolia" : "ethereum";
  if (currency === "sol") return environment === "sandbox" ? "solana-devnet" : "solana";
  return null;
}
export function validateDestination(currency: string, network: string, address: string, environment: MoonPayEnvironment): void {
  if (!expectedNetwork(currency, environment) || network !== expectedNetwork(currency, environment)) {
    throw new MoonPayInputError("Unsupported asset/network for this MoonPay environment.");
  }
  if (currency === "eth") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) throw new MoonPayInputError("Invalid Ethereum destination.");
  } else {
    try { if (new PublicKey(address).toBase58() !== address) throw new Error(); }
    catch { throw new MoonPayInputError("Invalid Solana destination."); }
  }
}
