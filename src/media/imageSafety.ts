/**
 * Phase 7D.3.2 §6 — the rules that make fetching a launcher-supplied image URL safe.
 *
 * A token's logo URL is attacker-controlled input: anyone launching a token chooses it.
 * Fetching it server-side and re-serving it is only safe if the fetch cannot be pointed at
 * internal infrastructure (SSRF) and the served bytes cannot be anything but an image.
 *
 * Pure and synchronous, so every rule is unit-tested without a network.
 */

import { BlockList, isIP } from "node:net";

export type ImagePlan =
  | { kind: "ipfs"; path: string }
  | { kind: "https"; url: string }
  | { kind: "rejected"; reason: string };

const CID_V0 = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;
const CID_V1_BASE32 = /^b[a-z2-7]{50,}$/;

function isCid(segment: string): boolean {
  return CID_V0.test(segment) || CID_V1_BASE32.test(segment);
}

/** Normalise an IPFS path (`<cid>[/sub/path]`), rejecting traversal and query strings. */
function ipfsPath(raw: string): string | null {
  const cleaned = raw.replace(/^\/+/, "").split(/[?#]/)[0];
  const [cid, ...rest] = cleaned.split("/");
  if (!isCid(cid)) return null;
  if (rest.some((p) => p === ".." || p === ".")) return null;
  return [cid, ...rest.filter((p) => p.length > 0).map((p) => encodeURIComponent(decodeURIComponent(p)))].join("/");
}

/**
 * Decide how to obtain an image. IPFS content is fetched through OnlyPump's configured
 * gateways regardless of which gateway the launcher happened to paste; anything that is not
 * plain HTTPS or IPFS is rejected outright.
 */
export function planImageFetch(logoUrl: string | null | undefined): ImagePlan {
  if (!logoUrl) return { kind: "rejected", reason: "no logo URL" };
  const value = logoUrl.trim();
  if (value.length > 2048) return { kind: "rejected", reason: "URL too long" };

  if (value.startsWith("ipfs://")) {
    const path = ipfsPath(value.slice("ipfs://".length).replace(/^ipfs\//, ""));
    return path ? { kind: "ipfs", path } : { kind: "rejected", reason: "malformed ipfs:// URL" };
  }
  if (isCid(value.split("/")[0])) {
    const path = ipfsPath(value);
    return path ? { kind: "ipfs", path } : { kind: "rejected", reason: "malformed CID path" };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "rejected", reason: "not a URL" };
  }
  if (url.protocol !== "https:") return { kind: "rejected", reason: `protocol ${url.protocol} is not allowed` };
  if (url.username || url.password) return { kind: "rejected", reason: "credentials in URL" };

  // Any path- or subdomain-style gateway: fetch the CID through our own gateways instead.
  const pathMatch = url.pathname.match(/^\/ipfs\/(.+)$/);
  if (pathMatch) {
    const path = ipfsPath(pathMatch[1]);
    if (path) return { kind: "ipfs", path };
  }
  const subdomain = url.hostname.split(".");
  if (subdomain.length > 2 && subdomain[1] === "ipfs" && isCid(subdomain[0])) {
    const path = ipfsPath(`${subdomain[0]}${url.pathname}`);
    if (path) return { kind: "ipfs", path };
  }

  // URL keeps IPv6 literals bracketed ("[::1]"), which isIP does not recognise.
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return { kind: "rejected", reason: "IP-literal hosts are not allowed" };
  if (url.port && url.port !== "443") return { kind: "rejected", reason: "non-standard port" };
  return { kind: "https", url: url.toString() };
}

const blocked = new BlockList();
// IPv4: unspecified, private, CGNAT, loopback, link-local, protocol assignments, benchmarking,
// documentation, multicast, reserved, broadcast.
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
// IPv6: unspecified, loopback, IPv4-mapped (checked separately below), NAT64, unique-local,
// link-local, multicast, documentation.
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True when an address must never be contacted by the image fetcher. */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family === 6) {
    const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(address, "ipv6");
  }
  return true; // not an IP at all — refuse rather than guess
}

export type SniffedImage = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/**
 * Identify the image type from its bytes. The upstream Content-Type header is ignored: it is
 * attacker-controlled, and an SVG or HTML payload labelled image/png must still be refused.
 */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (bytes.length >= 8 && starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (bytes.length >= 3 && starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (bytes.length >= 6 && (starts([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || starts([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))) return "image/gif";
  if (bytes.length >= 12 && starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}
