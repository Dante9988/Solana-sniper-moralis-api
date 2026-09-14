/**
 * Phase 7D.3.2 §6 — a deliberately narrow HTTPS GET for untrusted image URLs.
 *
 * The address check runs inside the socket's DNS `lookup` hook, i.e. on the exact address
 * the connection is about to use. Checking a hostname first and letting `fetch` resolve it
 * again would leave a DNS-rebinding gap between the two lookups.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import https from "node:https";
import type { LookupFunction } from "node:net";

import { isForbiddenAddress } from "./imageSafety";

export const IMAGE_FETCH_LIMITS = {
  maxBytes: 2 * 1024 * 1024,
  timeoutMs: 8_000,
  maxRedirects: 3,
} as const;

export class ImageFetchError extends Error {
  constructor(
    message: string,
    /** Permanent failures are never retried: the URL itself is unacceptable. */
    readonly permanent: boolean
  ) {
    super(message);
    this.name = "ImageFetchError";
  }
}

type Lookup = (hostname: string, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

const systemLookup: Lookup = (hostname, callback) => dnsLookup(hostname, { all: true }, callback);

function guardedLookup(resolve: Lookup): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, (err, addresses) => {
      if (err) return callback(err, "", 0);
      if (addresses.length === 0) return callback(new Error("no addresses"), "", 0);
      // Refuse if ANY resolved address is internal: a mixed answer is how rebinding is staged.
      const forbidden = addresses.find((a) => isForbiddenAddress(a.address));
      if (forbidden) {
        const e = new ImageFetchError(`host resolves to a forbidden address`, true) as unknown as NodeJS.ErrnoException;
        return callback(e, "", 0);
      }
      const chosen = addresses[0];
      if ((options as { all?: boolean }).all) {
        (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, [chosen]);
      } else {
        callback(null, chosen.address, chosen.family);
      }
    });
  };
}

export async function fetchImageBytes(
  url: string,
  options: { lookup?: Lookup; limits?: Partial<typeof IMAGE_FETCH_LIMITS> } = {}
): Promise<Uint8Array> {
  const limits = { ...IMAGE_FETCH_LIMITS, ...options.limits };
  const lookup = guardedLookup(options.lookup ?? systemLookup);
  let current = new URL(url);

  for (let hop = 0; hop <= limits.maxRedirects; hop += 1) {
    if (current.protocol !== "https:") throw new ImageFetchError(`redirect to ${current.protocol} refused`, true);

    const result = await new Promise<{ status: number; location?: string; body?: Uint8Array }>((resolve, reject) => {
      const req = https.get(
        current,
        { lookup, timeout: limits.timeoutMs, headers: { accept: "image/png,image/jpeg,image/gif,image/webp", "user-agent": "OnlyPump-ImageCache/1" } },
        (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            res.resume();
            resolve({ status, location: res.headers.location });
            return;
          }
          if (status !== 200) {
            res.resume();
            reject(new ImageFetchError(`upstream status ${status}`, status === 404 || status === 410));
            return;
          }
          const declared = Number(res.headers["content-length"]);
          if (Number.isFinite(declared) && declared > limits.maxBytes) {
            res.destroy();
            reject(new ImageFetchError(`declared size ${declared} exceeds ${limits.maxBytes}`, true));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            total += chunk.length;
            if (total > limits.maxBytes) {
              res.destroy();
              reject(new ImageFetchError(`body exceeds ${limits.maxBytes} bytes`, true));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve({ status, body: new Uint8Array(Buffer.concat(chunks)) }));
          res.on("error", (e) => reject(new ImageFetchError(e.message, false)));
        }
      );
      req.on("timeout", () => req.destroy(new ImageFetchError("timed out", false)));
      req.on("error", (e) => reject(e instanceof ImageFetchError ? e : new ImageFetchError(e.message, false)));
    });

    if (result.body) return result.body;
    if (!result.location) throw new ImageFetchError("redirect without location", true);
    current = new URL(result.location, current);
  }
  throw new ImageFetchError(`more than ${limits.maxRedirects} redirects`, true);
}
