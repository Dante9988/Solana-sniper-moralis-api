/**
 * Phase 7D.5 — every Robinhood Chain RPC request must identify itself.
 *
 * `rpc-robinhood.blockmachine.io` is the only configured endpoint that serves
 * `eth_getLogs` over wide block ranges. It sits behind Cloudflare, which answers a
 * request carrying no `User-Agent` with `403 / error code: 1010` before the node ever
 * sees it. viem's fetch transport sets no `User-Agent` of its own, so every wide-range
 * log query to that host failed, failover dropped to Alchemy free-tier endpoints capped
 * at a 10-block range, and Pons ingestion stalled while looking like a capacity problem.
 *
 * This test runs a real HTTP server and asserts the header is on the wire — a unit test
 * against the transport options would pass even if viem stopped forwarding them.
 */

import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { PonsChainClient } from "../chainClient";

let server: Server | undefined;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

/** A minimal JSON-RPC node that records the headers of every request it receives. */
async function startRecordingNode(result: string): Promise<{ url: string; headers: Record<string, string | undefined>[] }> {
  const headers: Record<string, string | undefined>[] = [];
  server = createServer((req, res) => {
    headers.push({ ...req.headers } as Record<string, string | undefined>);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const id = (JSON.parse(body) as { id: number }).id;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, headers };
}

describe("RPC transport identity", () => {
  it("sends a non-empty User-Agent on every request", async () => {
    const node = await startRecordingNode("0x1e8480");
    const client = new PonsChainClient({
      config: { chainId: 4663, rpcHttpUrl: node.url } as never,
    });

    const result = await client.getBlockNumber();

    expect(result.status).toBe("AVAILABLE");
    expect(node.headers).toHaveLength(1);
    const userAgent = node.headers[0]["user-agent"];
    expect(userAgent, "no User-Agent is exactly what Cloudflare rejects with 1010").toBeTruthy();
    expect(userAgent).toContain("OnlyPump");
  });

  it("carries no credential in the User-Agent", async () => {
    const node = await startRecordingNode("0x1e8480");
    const client = new PonsChainClient({ config: { chainId: 4663, rpcHttpUrl: node.url } as never });

    await client.getBlockNumber();

    // The header is sent to every provider, including ones we do not control.
    expect(node.headers[0]["user-agent"]).not.toMatch(/key|token|secret|[0-9a-f]{32}/i);
  });
});
