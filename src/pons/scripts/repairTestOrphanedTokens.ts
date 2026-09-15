/**
 * One-off repair for the 2026-09-14 incident (ARCHITECTURE.md §26.4): DB integration suites run
 * against the development database orphaned real Pons V2 launches and cleared their graduation
 * data. Nothing on chain reorganized.
 *
 * Fails closed:
 *   - only rows orphaned inside the incident window are candidates;
 *   - a row returns to CANONICAL only when its exact TokenLaunched log (block number, block hash,
 *     tx hash, log index, token) is found again on the canonical chain;
 *   - graduation fields are re-derived the same way DiscoveryV2Listener derives them
 *     (PoolGraduated + the Initialize log in the same block) and only fill rows that have none;
 *     a disagreement with existing data is reported, never overwritten.
 *
 * Dry run by default. `--apply` writes everything in one transaction.
 *
 *   npx ts-node src/pons/scripts/repairTestOrphanedTokens.ts            # dry run
 *   npx ts-node src/pons/scripts/repairTestOrphanedTokens.ts --apply
 *
 * Stop the pons worker first. Log scans need an endpoint that accepts wide eth_getLogs ranges
 * (DEAFULT_RPC_HTTPS); a sample of block hashes is cross-checked on a second provider.
 */

import "dotenv/config";

import { PrismaClient } from "@prisma/client";
import { getAbiItem } from "viem";

import { PONS_V2_FACTORY_ABI, UNISWAP_V4_POOL_MANAGER_ABI } from "../abiV2";
import { PonsChainClient } from "../chainClient";
import type { RawEvmLog } from "../ponsAdapter";
import { loadRobinhoodChainConfig } from "../config";
import { ponsV2Adapter } from "../ponsV2Adapter";

export const INCIDENT_WINDOW = { from: new Date("2026-09-14T00:41:00Z"), to: new Date("2026-09-14T00:43:00Z") };
const CHAIN = "robinhood";
const VENUE = "pons_v2";
const DISCOVERY_V2_SOURCE = "robinhood:pons_v2:discovery";

export interface LaunchFact {
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
}

export interface OrphanedRow {
  id: string;
  tokenAddress: string;
  sourceHeight: bigint;
  sourceHash: string;
  sourceTxHash: string;
  sourceIndex: number;
}

/** A row is restorable only when the launch log that created it is still exactly where it was. */
export function launchMatches(row: OrphanedRow, fact: LaunchFact | undefined): { ok: true } | { ok: false; reason: string } {
  if (!fact) return { ok: false, reason: "TokenLaunched log not found on the canonical chain" };
  if (fact.blockNumber !== row.sourceHeight) return { ok: false, reason: `height ${fact.blockNumber} != ${row.sourceHeight}` };
  if (fact.blockHash.toLowerCase() !== row.sourceHash.toLowerCase()) return { ok: false, reason: "block hash differs" };
  if (fact.txHash.toLowerCase() !== row.sourceTxHash.toLowerCase()) return { ok: false, reason: "tx hash differs" };
  if (fact.logIndex !== row.sourceIndex) return { ok: false, reason: `log index ${fact.logIndex} != ${row.sourceIndex}` };
  return { ok: true };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries a single read while the provider reports a rate limit; any other failure is returned as-is. */
async function withRateLimitRetry<T extends { status: string; reason?: string }>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const r = await fn();
    if (r.status !== "UNAVAILABLE" || attempt > 10 || !/rate limit|429|too many requests/i.test(r.reason ?? "")) return r;
    await sleep(2_000 * attempt);
  }
}

async function scanLogs(client: PonsChainClient, address: string, eventName: "TokenLaunched" | "PoolGraduated", from: bigint, to: bigint): Promise<RawEvmLog[]> {
  const event = getAbiItem({ abi: PONS_V2_FACTORY_ABI, name: eventName });
  const out: RawEvmLog[] = [];
  let span = 10_000n;
  let cursor = from;
  let rateLimited = 0;
  while (cursor <= to) {
    const end = cursor + span - 1n > to ? to : cursor + span - 1n;
    const r = await client.getLogs({ address, event, fromBlock: cursor, toBlock: end });
    if (r.status === "UNAVAILABLE") {
      // A rate limit says nothing about the range; wait instead of shrinking it.
      if (/rate limit|429|too many requests/i.test(r.reason) && rateLimited < 10) {
        rateLimited += 1;
        await sleep(2_000 * rateLimited);
        continue;
      }
      if (span <= 500n) throw new Error(`getLogs(${eventName}) ${cursor}-${end} failed: ${r.reason}`);
      span /= 2n;
      continue;
    }
    rateLimited = 0;
    out.push(...r.data);
    cursor = end + 1n;
    await sleep(300);
  }
  return out;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const config = loadRobinhoodChainConfig();
  const wideUrl = process.env.DEAFULT_RPC_HTTPS;
  const checkUrl = process.env.ROBINHOOD_RPC_HTTPS3 || process.env.ROBINHOOD_RPC_HTTPS2;
  const factory = process.env.PONS_V2_FACTORY;
  if (!wideUrl || !checkUrl || !factory) throw new Error("DEAFULT_RPC_HTTPS, a second RPC (ROBINHOOD_RPC_HTTPS3/2) and PONS_V2_FACTORY are required");

  const logsClient = new PonsChainClient({ config: { ...config, rpcHttpUrl: wideUrl }, requestTimeoutMs: 60_000 });
  const checkClient = new PonsChainClient({ config: { ...config, rpcHttpUrl: checkUrl } });
  const db = new PrismaClient();

  try {
    const candidates: OrphanedRow[] = (
      await db.discoveredToken.findMany({
        where: { chain: CHAIN, venue: VENUE, canonicalStatus: "ORPHANED", orphanedAt: { gte: INCIDENT_WINDOW.from, lte: INCIDENT_WINDOW.to } },
        select: { id: true, tokenAddress: true, sourceHeight: true, sourceHash: true, sourceTxHash: true, sourceIndex: true },
        orderBy: { sourceHeight: "asc" },
      })
    ).map((r) => ({ ...r, tokenAddress: r.tokenAddress.toLowerCase() }));
    const outsideWindow = await db.discoveredToken.count({
      where: { chain: CHAIN, canonicalStatus: "ORPHANED", NOT: { orphanedAt: { gte: INCIDENT_WINDOW.from, lte: INCIDENT_WINDOW.to } } },
    });
    const checkpoint = await db.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_V2_SOURCE } });
    if (!checkpoint) throw new Error(`no ${DISCOVERY_V2_SOURCE} checkpoint; refusing to guess the scan end`);
    console.log(`candidates (orphaned in incident window): ${candidates.length}; orphaned outside window (untouched): ${outsideWindow}`);
    if (candidates.length === 0) return;

    const from = candidates[0].sourceHeight;
    const to = checkpoint.lastHeight;
    console.log(`scanning factory logs ${from}-${to} (${to - from + 1n} blocks)`);

    const launchLogs = await scanLogs(logsClient, factory, "TokenLaunched", from, to);
    const launches = new Map<string, LaunchFact>();
    for (const log of launchLogs) {
      const d = ponsV2Adapter.decodeTokenDiscovered({ log, enrichment: { supply: 0n } } as never);
      if (!d) continue;
      launches.set(d.tokenAddress.toLowerCase(), { blockNumber: log.blockNumber, blockHash: log.blockHash, txHash: log.transactionHash, logIndex: log.logIndex });
    }
    const gradLogs = await scanLogs(logsClient, factory, "PoolGraduated", from, to);
    const grads = new Map<string, NonNullable<ReturnType<typeof ponsV2Adapter.decodeTokenGraduated>>>();
    for (const log of gradLogs) {
      const g = ponsV2Adapter.decodeTokenGraduated({ log });
      if (!g) continue;
      const key = g.tokenAddress.toLowerCase();
      if (grads.has(key)) throw new Error(`two PoolGraduated logs for ${key}; refusing to pick one`);
      grads.set(key, g);
    }
    console.log(`found ${launches.size} TokenLaunched and ${grads.size} PoolGraduated logs`);

    // Cross-provider sanity: the wide-range provider's block hashes must match a second provider.
    const sample = [...launches.values()].filter((_, i, a) => i % Math.max(1, Math.floor(a.length / 40)) === 0).slice(0, 40);
    for (const fact of sample) {
      const ref = await withRateLimitRetry(() => checkClient.getBlockRef(fact.blockNumber));
      if (ref.status !== "AVAILABLE") throw new Error(`cross-check getBlockRef(${fact.blockNumber}) unavailable: ${ref.reason}`);
      if (ref.data.hash.toLowerCase() !== fact.blockHash.toLowerCase()) throw new Error(`providers disagree on block ${fact.blockNumber}; refusing to continue`);
    }
    console.log(`cross-provider block hash check: ${sample.length}/${sample.length} agree`);

    const restore: string[] = [];
    const rejected: { token: string; reason: string }[] = [];
    for (const row of candidates) {
      const m = launchMatches(row, launches.get(row.tokenAddress));
      if (m.ok) restore.push(row.id);
      else rejected.push({ token: row.tokenAddress, reason: m.reason });
    }
    console.log(`restorable: ${restore.length}; stay ORPHANED: ${rejected.length}`);
    for (const r of rejected.slice(0, 20)) console.log(`  keep orphaned ${r.token}: ${r.reason}`);

    // Graduation: fill rows (restored or already canonical) that have none; report disagreements.
    const poolManager = await withRateLimitRetry(() => logsClient.readContract<string>({ address: factory, abi: PONS_V2_FACTORY_ABI, functionName: "poolManager", args: [] }));
    if (poolManager.status !== "AVAILABLE") throw new Error(`factory.poolManager() unavailable: ${poolManager.reason}`);
    const initializeEvent = getAbiItem({ abi: UNISWAP_V4_POOL_MANAGER_ABI, name: "Initialize" });
    const restoreSet = new Set(restore);
    const rows = await db.discoveredToken.findMany({
      where: { chain: CHAIN, venue: VENUE, tokenAddress: { in: [...grads.keys()] } },
      select: { id: true, tokenAddress: true, canonicalStatus: true, graduated: true, graduationSourceTxHash: true, poolId: true },
    });
    const gradUpdates: { id: string; token: string; data: Record<string, unknown> }[] = [];
    let alreadyCorrect = 0;
    const disagreements: string[] = [];
    let noRow = grads.size - rows.length;
    for (const row of rows) {
      const g = grads.get(row.tokenAddress.toLowerCase())!;
      const willBeCanonical = row.canonicalStatus === "CANONICAL" || restoreSet.has(row.id);
      if (!willBeCanonical) continue;
      if (row.graduated && row.graduationSourceTxHash) {
        if (row.graduationSourceTxHash.toLowerCase() === g.provenance.sourceTxHash.toLowerCase()) alreadyCorrect += 1;
        else disagreements.push(`${row.tokenAddress}: db ${row.graduationSourceTxHash} vs chain ${g.provenance.sourceTxHash}`);
        continue;
      }
      const height = BigInt(g.provenance.sourceHeight);
      const init = await withRateLimitRetry(() => logsClient.getLogs({ address: poolManager.data, event: initializeEvent, fromBlock: height, toBlock: height }));
      await sleep(200);
      if (init.status !== "AVAILABLE") throw new Error(`Initialize lookup at ${height} unavailable: ${init.reason}`);
      const identity = init.data.map((log) => ponsV2Adapter.decodePoolInitialized({ log }, row.tokenAddress)).find(Boolean) ?? null;
      gradUpdates.push({
        id: row.id,
        token: row.tokenAddress,
        data: {
          graduated: true,
          graduationPositionId: g.positionId,
          graduationTokenAmount: g.tokenAmount,
          graduationPairTokenAmount: g.pairTokenAmount,
          graduationSourceHeight: height,
          graduationSourceHash: g.provenance.sourceHash,
          graduationSourceTxHash: g.provenance.sourceTxHash,
          ...(identity ? { poolId: identity.poolId, isToken0: identity.isToken0 } : {}),
        },
      });
      if (!identity) console.log(`  ${row.tokenAddress}: graduated but no Initialize log found; poolId stays null`);
    }
    if (noRow > 0) console.log(`PoolGraduated logs with no DiscoveredToken row (launched before this database's history): ${noRow}`);
    console.log(`graduations: fill ${gradUpdates.length}, already correct ${alreadyCorrect}, disagreements ${disagreements.length}`);
    for (const d of disagreements) console.log(`  disagreement ${d}`);

    if (!apply) {
      console.log("DRY RUN: no changes written. Re-run with --apply.");
      return;
    }

    await db.$transaction(
      async (tx) => {
        const restored = await tx.discoveredToken.updateMany({
          where: { id: { in: restore }, canonicalStatus: "ORPHANED" },
          data: { canonicalStatus: "CANONICAL", orphanedAt: null },
        });
        for (const u of gradUpdates) {
          await tx.discoveredToken.update({ where: { id: u.id }, data: u.data });
        }
        console.log(`APPLIED: restored ${restored.count} rows, filled ${gradUpdates.length} graduations`);
      },
      { timeout: 300_000 }
    );
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err).replace(/https?:\/\/\S+/g, "<url>"));
    process.exit(1);
  });
}
