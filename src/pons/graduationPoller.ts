/**
 * Phase 7B.4 §4.6 — graduation poller.
 *
 * Pons has no graduation event (verified on-chain — see abi.ts). This is a
 * scheduled read of graduationStatus(token) for tracked, not-yet-graduated
 * tokens, on its own interval, deliberately separate from the discovery and
 * trade listeners' block-range polling — it doesn't consume blocks at all.
 */

import type { PrismaClient } from "@prisma/client";
import { ChainReader } from "./chainClient";
import { RobinhoodChainConfig } from "./config";
import { PONS_FACTORY_ABI } from "./abi";

export type GraduationPollResult =
  | { status: "NO_POOLS_TRACKED" }
  | { status: "POLLED"; checked: number; newlyGraduated: number; failures: number }
  | { status: "UNAVAILABLE"; reason: string };

export interface GraduationPollerLogger {
  info: (message: string, fields?: Record<string, unknown>) => void;
  warn: (message: string, fields?: Record<string, unknown>) => void;
  error: (message: string, fields?: Record<string, unknown>) => void;
}

const noopLogger: GraduationPollerLogger = { info: () => {}, warn: () => {}, error: () => {} };

export interface GraduationPollerDeps {
  chainClient: ChainReader;
  db: PrismaClient;
  config: RobinhoodChainConfig;
  logger?: GraduationPollerLogger;
}

export class GraduationPoller {
  private readonly chainClient: ChainReader;
  private readonly db: PrismaClient;
  private readonly config: RobinhoodChainConfig;
  private readonly logger: GraduationPollerLogger;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  /** Phase 7B.5A §7 — tracked so a graceful shutdown can await the in-flight tick (waitForIdle()) rather than disconnecting Prisma mid-transaction. */
  private currentTick: Promise<void> = Promise.resolve();

  constructor(deps: GraduationPollerDeps) {
    this.chainClient = deps.chainClient;
    this.db = deps.db;
    this.config = deps.config;
    this.logger = deps.logger ?? noopLogger;
  }

  async runOnce(): Promise<GraduationPollResult> {
    const notGraduated = await this.db.discoveredToken.findMany({
      // Phase 7B.5A §2/§9 — never poll a reorg-orphaned row; it is no
      // longer a canonical fact and its graduation state was already reset
      // by reorgRecovery.ts.
      where: { chain: "robinhood", graduated: false, canonicalStatus: "CANONICAL", enrichmentStatus: "COMPLETE" },
      select: { tokenAddress: true },
    });
    if (notGraduated.length === 0) return { status: "NO_POOLS_TRACKED" };

    let newlyGraduated = 0;
    let failures = 0;
    for (const { tokenAddress } of notGraduated) {
      // graduationStatus returns a plain positional tuple, not a named
      // struct — verified live: a first attempt at named-property access
      // (result.data.pairedPrincipal) threw "Cannot read properties of
      // undefined" against the real factory. viem only exposes named
      // access for ABI outputs wrapped in a single tuple/struct type; three
      // separate top-level outputs decode as [a, b, c].
      const result = await this.chainClient.readContract<readonly [bigint, bigint, boolean]>({
        address: this.config.factoryAddress,
        abi: PONS_FACTORY_ABI,
        functionName: "graduationStatus",
        args: [tokenAddress],
      });

      if (result.status === "UNAVAILABLE") {
        failures += 1;
        this.logger.warn(`graduationStatus(${tokenAddress}) unavailable: ${result.reason}`);
        continue; // one token's failure doesn't block checking the rest — each is an independent read
      }

      const [pairedPrincipal, threshold, graduated] = result.data;

      await this.db.discoveredToken.update({
        where: { chain_tokenAddress: { chain: "robinhood", tokenAddress } },
        data: {
          graduated,
          graduationPairedPrincipal: pairedPrincipal.toString(),
          graduationThreshold: threshold.toString(),
          graduationCheckedAt: new Date(),
        },
      });
      if (graduated) newlyGraduated += 1;
    }

    this.logger.info(`Graduation poll: checked ${notGraduated.length}, ${newlyGraduated} newly graduated, ${failures} read failure(s).`);
    return { status: "POLLED", checked: notGraduated.length, newlyGraduated, failures };
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    const tick = async () => {
      if (this.stopping) return;
      this.currentTick = (async () => {
        try {
          await this.runOnce();
        } catch (err) {
          this.logger.error(`Graduation poller tick threw unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
        }
      })();
      await this.currentTick;
      if (!this.stopping) {
        this.timer = setTimeout(tick, this.config.graduationPollIntervalMs);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Phase 7B.5A §7 — graceful shutdown: await this after stop() so the process never disconnects Prisma while a tick's transaction is still in flight. Resolves immediately if no tick is currently running. */
  async waitForIdle(): Promise<void> {
    await this.currentTick;
  }
}
