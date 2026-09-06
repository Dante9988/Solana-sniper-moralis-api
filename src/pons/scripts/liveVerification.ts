/**
 * Phase 7B.4 — no-mock completion policy: "real log subscription against
 * Robinhood Chain ... producing rows in real tables" and "a decoded
 * TokenLaunched and a decoded Swap from actual chain data."
 *
 * IMPORTANT DEVIATION, reported honestly rather than silently worked
 * around: phase7b4.txt asked to "build and prove against testnet first."
 * Testnet reachability was confirmed (correct chain ID, real blocks), but
 * the documented mainnet Pons factory (0xA5aAb...) and WETH_QUOTE address
 * both return empty bytecode ("0x") on testnet via eth_getCode — there is
 * no known Pons deployment on testnet available to this project. This
 * script therefore runs against MAINNET instead, read-only (getLogs/
 * getBlock/readContract only — no transactions, no signing, no risk),
 * over the same historical block range independently verified during ABI
 * resolution (block 9019252), so it exercises the real discovery and
 * trade listeners against genuinely live infrastructure and real captured
 * chain data — just not testnet specifically. See the completion report
 * for the testnet blocker.
 *
 * Run: npx ts-node src/pons/scripts/liveVerification.ts
 */
import { PrismaClient } from "@prisma/client";
import { loadRobinhoodChainConfig } from "../config";
import { PonsChainClient } from "../chainClient";
import { DiscoveryListener } from "../discoveryListener";
import { TradeListener } from "../tradeListener";

const VERIFIED_LAUNCH_BLOCK = 9_019_252n;

async function main() {
  const config = loadRobinhoodChainConfig({
    ...process.env,
    // Override the poll window so this one-shot run covers exactly the
    // historical block independently verified during ABI resolution,
    // rather than "the last N blocks near the live tip" (which was
    // observed to be sparse — no TokenLaunched events in the most recent
    // 1,000,000 blocks as of this phase's Step 0 audit).
    PONS_FRESH_START_LOOKBACK_BLOCKS: "1",
    PONS_CONFIRMATION_LAG_BLOCKS: "1",
    PONS_MAX_BLOCK_RANGE_PER_POLL: "50000",
  });

  const chainClient = new PonsChainClient({ config });
  const db = new PrismaClient();
  const logger = { info: console.log, warn: console.warn, error: console.error };

  try {
    const latest = await chainClient.getBlockNumber();
    if (latest.status === "UNAVAILABLE") {
      console.log(`BLOCKER: cannot reach Robinhood Chain mainnet RPC: ${latest.reason}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Connected to Robinhood Chain mainnet. Latest block: ${latest.data}.`);

    // Force the discovery/trade listeners to start at the verified launch
    // block by seeding a checkpoint one block before it, rather than
    // depending on freshStartLookbackBlocks landing exactly there.
    await db.chainIngestionCheckpoint.deleteMany({ where: { source: { in: ["robinhood:pons:discovery", "robinhood:pons:trades"] } } });
    await db.chainIngestionCheckpoint.createMany({
      data: [
        { source: "robinhood:pons:discovery", lastHeight: VERIFIED_LAUNCH_BLOCK - 1n, lastHash: (await chainClient.getBlockRef(VERIFIED_LAUNCH_BLOCK - 1n) as { status: "AVAILABLE"; data: { hash: string } }).data.hash },
      ],
    });

    const discoveryListener = new DiscoveryListener({ chainClient, db, config, logger });
    const discoveryResult = await discoveryListener.runOnce();
    console.log("Discovery tick result:", discoveryResult);

    if (discoveryResult.status === "PROCESSED" && discoveryResult.tokensDiscovered > 0) {
      const seeded = await db.discoveredToken.findMany({ where: { chain: "robinhood" } });
      console.log(`Real rows in DiscoveredToken after live discovery run: ${seeded.length}`);
      for (const row of seeded) {
        console.log(`  token=${row.tokenAddress} pool=${row.poolAddress} supply=${row.supply?.toFixed() ?? "PENDING"} txHash=${row.sourceTxHash}`);
      }

      await db.chainIngestionCheckpoint.upsert({
        where: { source: "robinhood:pons:trades" },
        create: { source: "robinhood:pons:trades", lastHeight: VERIFIED_LAUNCH_BLOCK - 1n, lastHash: (await chainClient.getBlockRef(VERIFIED_LAUNCH_BLOCK - 1n) as { status: "AVAILABLE"; data: { hash: string } }).data.hash },
        update: { lastHeight: VERIFIED_LAUNCH_BLOCK - 1n },
      });
      const tradeListener = new TradeListener({ chainClient, db, config, logger });
      const tradeResult = await tradeListener.runOnce();
      console.log("Trade tick result:", tradeResult);

      if (tradeResult.status === "PROCESSED") {
        const trades = await db.chainTrade.findMany({ where: { chain: "robinhood" } });
        console.log(`Real rows in ChainTrade after live trade run: ${trades.length}`);
        for (const row of trades) {
          console.log(`  token=${row.tokenAddress} side=${row.side} tokenAmount=${row.tokenAmount.toFixed()} txHash=${row.sourceTxHash}`);
        }
      }
    }

    console.log("Live verification complete.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exitCode = 1;
});
