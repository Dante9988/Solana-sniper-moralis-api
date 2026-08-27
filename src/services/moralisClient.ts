import axios, { AxiosError } from "axios";
import { z } from "zod";

const BASE_URL = "https://solana-gateway.moralis.io";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

export type MoralisFailureCode =
  | "TOKEN_NOT_FOUND"
  | "ENDPOINT_REMOVED"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "MALFORMED_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "HTTP_ERROR"
  | "NETWORK_ERROR";

export type MoralisResult<T> =
  | { status: "AVAILABLE"; source: "MORALIS"; retrievedAt: string; data: T }
  | { status: "UNAVAILABLE"; source: "MORALIS"; retrievedAt: string; code: MoralisFailureCode; error: string };

const nullableString = z.string().nullable().optional();
const metadataSchema = z.object({
  mint: z.string().optional(), standard: z.string().optional(), name: z.string().nullable().optional(),
  symbol: z.string().nullable().optional(), logo: nullableString, decimals: z.string().optional(),
  fullyDilutedValue: nullableString, totalSupply: z.string().optional(), totalSupplyFormatted: z.string().optional(),
  links: z.record(z.string(), z.unknown()).nullable().optional(), description: nullableString,
  metaplex: z.object({
    metadataUri: nullableString, masterEdition: z.boolean().optional(), isMutable: z.boolean().optional(),
    sellerFeeBasisPoints: z.number().optional(), updateAuthority: nullableString, primarySaleHappened: z.number().optional(),
  }).nullable().optional(),
});

const priceSchema = z.object({
  tokenAddress: z.string().optional(), pairAddress: nullableString, exchangeName: nullableString,
  exchangeAddress: nullableString, usdPrice: z.number().nullable().optional(), usdPrice24h: z.number().nullable().optional(),
  usdPrice24hrUsdChange: z.number().nullable().optional(), usdPrice24hrPercentChange: z.number().nullable().optional(),
  logo: nullableString, name: nullableString, symbol: nullableString,
});

const swapTokenSchema = z.object({ address: z.string().optional(), usdPrice: z.number().nullable().optional() }).passthrough();
const swapsSchema = z.object({
  cursor: nullableString, page: z.number().optional(), pageSize: z.number().optional(),
  result: z.array(z.object({ bought: swapTokenSchema.nullable().optional(), sold: swapTokenSchema.nullable().optional() }).passthrough()).default([]),
});
const pairsSchema = z.object({ cursor: nullableString, page: z.number().optional(), pageSize: z.number().optional(), pairs: z.array(z.object({ pairAddress: z.string() }).passthrough()).default([]) });
const pairStatsSchema = z.object({ pairAddress: z.string(), tokenAddress: z.string().optional(), currentUsdPrice: nullableString, totalLiquidityUsd: nullableString }).passthrough();

export type MoralisMetadata = z.infer<typeof metadataSchema>;
export type MoralisPrice = z.infer<typeof priceSchema>;
export type MoralisSwaps = z.infer<typeof swapsSchema>;
export type MoralisPairs = z.infer<typeof pairsSchema>;
export type MoralisPairStats = z.infer<typeof pairStatsSchema>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function failure<T>(code: MoralisFailureCode, error: string): MoralisResult<T> {
  return { status: "UNAVAILABLE", source: "MORALIS", retrievedAt: new Date().toISOString(), code, error };
}

function classify(error: unknown): { code: MoralisFailureCode; retryable: boolean; message: string } {
  if (!axios.isAxiosError(error)) return { code: "NETWORK_ERROR", retryable: false, message: "Moralis request failed" };
  const value = error as AxiosError;
  if (value.code === "ECONNABORTED" || value.code === "ETIMEDOUT") return { code: "TIMEOUT", retryable: false, message: "Moralis request timed out" };
  if (value.code === "ERR_BAD_RESPONSE" && /maxContentLength|larger than/i.test(value.message)) return { code: "RESPONSE_TOO_LARGE", retryable: false, message: "Moralis response exceeded the size limit" };
  const status = value.response?.status;
  if (status === 401) return { code: "AUTHENTICATION_FAILED", retryable: false, message: "Moralis authentication failed" };
  if (status === 403) return { code: "PERMISSION_DENIED", retryable: false, message: "Moralis permission denied" };
  if (status === 404) return { code: "TOKEN_NOT_FOUND", retryable: false, message: "Token was not found by Moralis" };
  if (status === 429) return { code: "RATE_LIMITED", retryable: true, message: "Moralis rate limit reached" };
  if (status && status >= 500) return { code: "HTTP_ERROR", retryable: true, message: `Moralis server error (${status})` };
  return { code: value.response ? "HTTP_ERROR" : "NETWORK_ERROR", retryable: false, message: "Moralis request failed" };
}

async function request<T>(path: string, schema: z.ZodType<T>): Promise<MoralisResult<T>> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await axios.get(`${BASE_URL}${path}`, {
        headers: { Accept: "application/json", "X-Api-Key": process.env.MORALIS_API_KEY ?? "" },
        timeout: Number(process.env.MORALIS_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
        maxContentLength: MAX_RESPONSE_BYTES,
        maxBodyLength: MAX_RESPONSE_BYTES,
        responseType: "json",
      });
      const parsed = schema.safeParse(response.data);
      if (!parsed.success) return failure("MALFORMED_RESPONSE", "Moralis response failed schema validation");
      return { status: "AVAILABLE", source: "MORALIS", retrievedAt: new Date().toISOString(), data: parsed.data };
    } catch (error) {
      const classified = classify(error);
      if (!classified.retryable || attempt === MAX_ATTEMPTS - 1) return failure(classified.code, classified.message);
      await sleep(100 * 2 ** attempt);
    }
  }
  return failure("NETWORK_ERROR", "Moralis request failed");
}

const address = (value: string) => encodeURIComponent(value);
export const getMoralisMetadata = (mint: string) => request(`/token/mainnet/${address(mint)}/metadata`, metadataSchema);
export const getMoralisPrice = (mint: string) => request(`/token/mainnet/${address(mint)}/price`, priceSchema);
export const getMoralisSwaps = (mint: string, limit = 10, cursor?: string) => {
  const query = new URLSearchParams({ order: "DESC", limit: String(Math.min(100, Math.max(1, limit))) });
  if (cursor) query.set("cursor", cursor);
  return request(`/token/mainnet/${address(mint)}/swaps?${query}`, swapsSchema);
};
export const getMoralisPairs = (mint: string, limit = 50) => request(`/token/mainnet/${address(mint)}/pairs?limit=${Math.min(50, Math.max(1, limit))}`, pairsSchema);
export const getMoralisPairStats = (pairAddress: string) => request(`/token/mainnet/pairs/${address(pairAddress)}/stats`, pairStatsSchema);

/** Retired REST evidence is explicit unknown, never a zero-valued safety signal. */
export function removedMoralisEndpoint(feature: string): MoralisResult<never> {
  return failure("ENDPOINT_REMOVED", `${feature} REST endpoint was removed by Moralis`);
}
