/**
 * Phase 7B.5A §2/§11 — proves reorg recovery against a REAL, genuinely
 * reorging local EVM node (Foundry's `anvil`, via its `evm_snapshot`/
 * `evm_revert` cheatcodes), driving this repo's actual production
 * `PonsChainClient` (real viem HTTP JSON-RPC, no mocked transport),
 * `DiscoveryListener`, and `reorgRecovery.ts` — not a scripted
 * `FakeChainReader`. `reorgRecovery.dbIntegration.test.ts` already proves
 * the algorithm's local mechanics against canned chain responses; this
 * file additionally proves the same code path against a node that has
 * actually forked, using two tiny mock contracts
 * (`fixtures/mockContracts.ts`) that emit the exact real Pons
 * `TokenLaunched` event signature this repo already verified on-chain
 * (src/pons/abi.ts) — so `ponsAdapter.ts`'s real decoder genuinely decodes
 * these logs, not a parallel test-only decode path.
 *
 * This is the strongest reorg proof available without touching Robinhood
 * Chain mainnet itself, which cannot safely or responsibly be forced to
 * reorg (phase7b5a.txt §11: "Do not force or simulate destructive behavior
 * against mainnet"). snapshot/revert against a local, disposable,
 * throwaway anvil instance is the standard technique the EVM tooling
 * ecosystem uses for exactly this — it is not a shortcut around the "real
 * infrastructure" requirement, it *is* real infrastructure (a real
 * Ethereum-JSON-RPC node), just not the specific chain this project talks
 * to in production.
 *
 * Requires the `anvil` binary (Foundry: https://getfoundry.sh) on PATH.
 * Opt-in — spins up its own throwaway node on 127.0.0.1, touches nothing
 * external:
 *
 *   PONS_RUN_ANVIL_REORG_TEST=true DATABASE_URL=postgresql://... npx vitest run src/pons/__tests__/reorgRecovery.anvilFork.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { PrismaClient } from "@prisma/client";
import { createWalletClient, createTestClient, defineChain, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PonsChainClient } from "../chainClient";
import { DiscoveryListener, DISCOVERY_CHECKPOINT_SOURCE, ROBINHOOD_CHAIN } from "../discoveryListener";
import { CheckpointStore, recordChainBlockCheckpoint } from "../checkpointStore";
import { RobinhoodChainConfig } from "../config";
import { MOCK_PONS_FACTORY_ABI, MOCK_PONS_FACTORY_BYTECODE } from "./fixtures/mockContracts";

const RUN = process.env.PONS_RUN_ANVIL_REORG_TEST === "true";
const PORT = 8646;
const RPC_URL = `http://127.0.0.1:${PORT}`;
// Foundry/anvil's well-known, publicly documented default dev account #0
// (derived from the standard test mnemonic "test test test test test test
// test test test test test junk"). Test-only, funded only on this
// throwaway localhost instance — never a real key, never used off-anvil.
const ANVIL_DEV_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const anvilChain = defineChain({
  id: 31337,
  name: "anvil-reorg-test",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

async function waitForAnvilReady(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`anvil did not become ready on ${RPC_URL} within 15s`);
}

describe.skipIf(!RUN)("reorg recovery — real anvil fork integration (genuine node reorg, real PonsChainClient)", () => {
  let anvil: ChildProcess;
  const prisma = new PrismaClient();

  const account = privateKeyToAccount(ANVIL_DEV_PRIVATE_KEY);
  const wallet = createWalletClient({ account, chain: anvilChain, transport: http(RPC_URL) }).extend(publicActions);
  const testClient = createTestClient({ mode: "anvil", chain: anvilChain, transport: http(RPC_URL) });

  async function cleanup() {
    await prisma.discoveredToken.deleteMany({ where: { chain: ROBINHOOD_CHAIN, deployer: account.address.toLowerCase() } });
    await prisma.chainIngestionCheckpoint.deleteMany({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
    await prisma.chainBlockCheckpoint.deleteMany({ where: { chain: ROBINHOOD_CHAIN } });
  }

  beforeAll(async () => {
    anvil = spawn("anvil", ["--port", String(PORT), "--chain-id", "31337", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
    await waitForAnvilReady();
    await cleanup();
  }, 30_000);

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    anvil.kill();
  });

  it(
    "detects a genuine node-level reorg (evm_snapshot/evm_revert), finds the pre-fork ancestor, orphans the reorged-out launch, and replays the canonical one",
    async () => {
      // --- Deploy the mock factory for real, via a real signed transaction. ---
      const deployHash = await wallet.deployContract({ abi: MOCK_PONS_FACTORY_ABI, bytecode: MOCK_PONS_FACTORY_BYTECODE, args: [] });
      const deployReceipt = await wallet.waitForTransactionReceipt({ hash: deployHash });
      const factoryAddress = deployReceipt.contractAddress;
      expect(factoryAddress).toBeTruthy();

      const config: RobinhoodChainConfig = Object.freeze({
        chainId: 31337,
        rpcHttpUrl: RPC_URL,
        rpcWsUrl: "wss://unused-in-this-test.invalid",
        explorerUrl: "https://unused-in-this-test.invalid",
        factoryAddress: factoryAddress!,
        lockerAddress: "0x0000000000000000000000000000000000000001",
        factoryLegacyAddress: "0x0000000000000000000000000000000000000002",
        lockerLegacyAddress: "0x0000000000000000000000000000000000000003",
        quoteAddress: "0x0000000000000000000000000000000000000004",
        pollIntervalMs: 5_000,
        graduationPollIntervalMs: 60_000,
        maxBlockRangePerPoll: 1_000,
        confirmationLagBlocks: 0,
        freshStartLookbackBlocks: 1_000,
        enrichmentConcurrency: 5,
        enrichmentRetryBatchSize: 25,
        tradePoolChunkSize: 40,
        tradeQueryConcurrency: 3,
        reorgMaxDepthBlocks: 500,
        healthLaggingBlocks: 50,
        healthStaleMs: 120_000,
        healthErrorWindowMs: 60_000,
      });

      // Real PonsChainClient (real viem HTTP transport) pointed at the real anvil node — no injected fake.
      const chainClient = new PonsChainClient({ config });
      const discoveryListener = new DiscoveryListener({ chainClient, db: prisma, config });

      // --- Establish a pre-fork baseline the ancestor search can find later. ---
      const baseHeightResult = await chainClient.getBlockNumber();
      if (baseHeightResult.status === "UNAVAILABLE") throw new Error(`getBlockNumber unavailable: ${baseHeightResult.reason}`);
      const baseHeight = baseHeightResult.data;
      const baseHashResult = await chainClient.getBlockRef(baseHeight);
      if (baseHashResult.status === "UNAVAILABLE") throw new Error(`getBlockRef unavailable: ${baseHashResult.reason}`);

      await new CheckpointStore(prisma).set(DISCOVERY_CHECKPOINT_SOURCE, { lastHeight: baseHeight, lastHash: baseHashResult.data.hash });
      await recordChainBlockCheckpoint(prisma, ROBINHOOD_CHAIN, baseHeight, baseHashResult.data.hash, config.reorgMaxDepthBlocks);

      // --- Fork point. ---
      const snapshotId = await testClient.snapshot();

      // --- "Chain A": launch tokenA, mine forward, let discovery persist it. ---
      const tokenA = "0x00000000000000000000000000000000000000a1";
      const poolA = "0x00000000000000000000000000000000000000a2";
      const launchATx = await wallet.writeContract({ address: factoryAddress!, abi: MOCK_PONS_FACTORY_ABI, functionName: "launch", args: [tokenA, poolA, config.quoteAddress as `0x${string}`, 111n] });
      await wallet.waitForTransactionReceipt({ hash: launchATx });
      await testClient.mine({ blocks: 2 });

      const tickA = await discoveryListener.runOnce();
      expect(tickA.status).toBe("PROCESSED");
      if (tickA.status !== "PROCESSED") throw new Error("expected PROCESSED for chain A");
      expect(tickA.tokensDiscovered).toBe(1);

      const tokenARow = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress: tokenA } } });
      expect(tokenARow?.canonicalStatus).toBe("CANONICAL");
      expect(tokenARow?.enrichmentStatus).toBe("COMPLETE");
      expect(tokenARow?.supply?.toFixed()).toBe("1000000000000000000000000");

      // --- Real reorg: revert the node to the fork point. Chain A's blocks (and tokenA's launch) no longer exist on this node. ---
      await testClient.revert({ id: snapshotId });

      // --- "Chain B": a DIFFERENT launch replaces it at the same height range. ---
      const tokenB = "0x00000000000000000000000000000000000000b1";
      const poolB = "0x00000000000000000000000000000000000000b2";
      const launchBTx = await wallet.writeContract({ address: factoryAddress!, abi: MOCK_PONS_FACTORY_ABI, functionName: "launch", args: [tokenB, poolB, config.quoteAddress as `0x${string}`, 222n] });
      await wallet.waitForTransactionReceipt({ hash: launchBTx });
      await testClient.mine({ blocks: 2 });

      // Sanity: the node has genuinely forked — same height as tickA's committed checkpoint, different real hash.
      const postForkHashResult = await chainClient.getBlockRef(tickA.toBlock);
      if (postForkHashResult.status === "UNAVAILABLE") throw new Error("post-fork getBlockRef unavailable");
      const preForkCheckpoint = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
      expect(postForkHashResult.data.hash.toLowerCase()).not.toBe(preForkCheckpoint!.lastHash.toLowerCase());

      // --- Discovery detects the real mismatch and recovers using the real chain client. ---
      const reorgTick = await discoveryListener.runOnce();
      expect(reorgTick.status).toBe("REORG_RECOVERED");
      if (reorgTick.status !== "REORG_RECOVERED") throw new Error("expected REORG_RECOVERED");
      expect(reorgTick.ancestorHeight.toString()).toBe(baseHeight.toString());

      const tokenARowAfterReorg = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress: tokenA } } });
      expect(tokenARowAfterReorg?.canonicalStatus).toBe("ORPHANED");
      expect(tokenARowAfterReorg?.orphanedAt).not.toBeNull();

      const checkpointAfterReorg = await prisma.chainIngestionCheckpoint.findUnique({ where: { source: DISCOVERY_CHECKPOINT_SOURCE } });
      expect(checkpointAfterReorg?.lastHeight.toString()).toBe(baseHeight.toString());
      expect(checkpointAfterReorg?.lastHash.toLowerCase()).toBe(baseHashResult.data.hash.toLowerCase());

      // --- Ordinary replay from the ancestor discovers the new canonical fact. ---
      const replayTick = await discoveryListener.runOnce();
      expect(replayTick.status).toBe("PROCESSED");
      if (replayTick.status !== "PROCESSED") throw new Error("expected PROCESSED for the replay tick");
      expect(replayTick.tokensDiscovered).toBe(1);

      const tokenBRow = await prisma.discoveredToken.findUnique({ where: { chain_tokenAddress: { chain: ROBINHOOD_CHAIN, tokenAddress: tokenB } } });
      expect(tokenBRow?.canonicalStatus).toBe("CANONICAL");
      expect(tokenBRow?.enrichmentStatus).toBe("COMPLETE");

      // The read-route invariant this whole phase exists to protect: an
      // orphaned row must never come back from a canonical-only query.
      const canonicalOnly = await prisma.discoveredToken.findMany({ where: { chain: ROBINHOOD_CHAIN, canonicalStatus: "CANONICAL", tokenAddress: { in: [tokenA, tokenB] } } });
      expect(canonicalOnly.map((r) => r.tokenAddress)).toEqual([tokenB]);
    },
    60_000
  );
});
