import { describe, expect, it } from "vitest";
import { decodeEventLog } from "viem";

import fixture from "../__fixtures__/curveTrades.json";
import { PONS_V2_CURVE_ABI } from "../abiV2";
import { ponsV2Adapter } from "../ponsV2Adapter";
import type { RawEvmLog } from "../ponsAdapter";

/** Phase 7D.4 §3 — decode real PonsV2BondingCurve trade logs captured from mainnet. */

type Row = (typeof fixture.rows)[number];
const rawLog = (row: Row): RawEvmLog => ({ ...row.log, topics: row.log.topics as `0x${string}`[], data: row.log.data as `0x${string}`, blockNumber: BigInt(row.log.blockNumber) });

describe("ponsV2Adapter.decodeCurveTrade (real mainnet logs)", () => {
  it("every captured emitter was the factory-registered curve for its token", () => {
    expect(fixture.rows.length).toBeGreaterThanOrEqual(6);
    for (const row of fixture.rows) expect(row.emitterIsFactoryCurve).toBe(true);
  });

  it("decodes buys and sells with trader-side amounts, the recipient as trader, and the fee legs", () => {
    for (const row of fixture.rows) {
      const log = rawLog(row);
      const trade = ponsV2Adapter.decodeCurveTrade({ log, tokenAddress: row.token, curveAddress: row.emitter, quoteAddress: row.pairToken });
      expect(trade, `${row.event} ${row.log.transactionHash}`).not.toBeNull();
      const args = decodeEventLog({ abi: PONS_V2_CURVE_ABI, topics: log.topics as [`0x${string}`], data: log.data }).args as Record<string, bigint | string>;
      if (row.event === "CurveBuy") {
        expect(trade!.side).toBe("buy");
        expect(trade!.tokenAmount).toBe((args.tokensOut as bigint).toString());
        expect(trade!.quoteAmount).toBe((args.quoteIn as bigint).toString());
      } else {
        expect(trade!.side).toBe("sell");
        expect(trade!.tokenAmount).toBe((args.tokensIn as bigint).toString());
        expect(trade!.quoteAmount).toBe((args.quoteOut as bigint).toString());
      }
      expect(trade!.trader.toLowerCase()).toBe((args.recipient as string).toLowerCase());
      expect(trade!.feeQuote).toBe((args.fee as bigint).toString());
      expect(trade!.taxQuote).toBe((args.tax as bigint).toString());
      expect(trade!.provenance.sourceTxHash).toBe(row.log.transactionHash);
      expect(trade!.provenance.sourceIndex).toBe(row.log.logIndex);
      expect(Number(trade!.priceQuote)).toBeGreaterThan(0);
    }
  });

  it("refuses a look-alike log from a contract that is not the token's curve", () => {
    const row = fixture.rows[0];
    const spoof = ponsV2Adapter.decodeCurveTrade({ log: rawLog(row), tokenAddress: row.token, curveAddress: "0x000000000000000000000000000000000000dEaD", quoteAddress: row.pairToken });
    expect(spoof).toBeNull();
  });

  it("refuses a log whose topic0 is not a curve trade", () => {
    const row = fixture.rows[0];
    const other = { ...rawLog(row), topics: ["0x" + "11".repeat(32), ...row.log.topics.slice(1)] as `0x${string}`[] };
    expect(ponsV2Adapter.decodeCurveTrade({ log: other, tokenAddress: row.token, curveAddress: row.emitter, quoteAddress: row.pairToken })).toBeNull();
  });
});
