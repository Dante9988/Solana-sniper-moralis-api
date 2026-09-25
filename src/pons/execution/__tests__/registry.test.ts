/**
 * Phase 7E.1 §9 — route selection, and §20's gate in the API config.
 */

import { describe, expect, it } from "vitest";

import { ApiConfigError, loadApiConfig } from "../../../researchApi/config";
import { EXECUTION_VENUES, selectRoute, venueById } from "../registry";
import { curveBuyQuote, poolBuyQuote } from "./testSupport";

describe("selectRoute", () => {
  it("routes a curve quote to the curve venue and a pool quote to the V4 venue", () => {
    expect(selectRoute(curveBuyQuote())).toMatchObject({ status: "SELECTED", venue: { id: "ROBINHOOD_PONS_CURVE" } });
    expect(selectRoute(poolBuyQuote())).toMatchObject({ status: "SELECTED", venue: { id: "ROBINHOOD_UNISWAP_V4" } });
  });

  it("reports no route rather than falling back to a venue that does not support the quote", () => {
    const orphan = curveBuyQuote({ venue: "SOMETHING_ELSE" as never });
    expect(selectRoute(orphan)).toMatchObject({ status: "NO_ROUTE" });
  });

  it("refuses rather than picking a winner when two venues claim the same quote", () => {
    const greedy = EXECUTION_VENUES.map((venue) => ({ ...venue, supports: () => true })) as never;
    const result = selectRoute(curveBuyQuote(), greedy);
    expect(result.status).toBe("AMBIGUOUS");
  });

  it("resolves a venue by id and returns null for an unknown one", () => {
    expect(venueById("ROBINHOOD_PONS_CURVE")?.id).toBe("ROBINHOOD_PONS_CURVE");
    expect(venueById("NOPE" as never)).toBeNull();
  });
});

describe("REAL_TRADING_ENABLED", () => {
  const base = { SUPABASE_URL: "", API_KEYS: "k" } as NodeJS.ProcessEnv;

  it("is off when unset, so a deploy can never turn real trading on by accident", () => {
    const config = loadApiConfig({ ...base });
    expect(config.realTrading.enabled).toBe(false);
    expect(config.realTrading.venues.size).toBe(0);
  });

  it("is off when explicitly false, and lists no venues even if some are named", () => {
    const config = loadApiConfig({ ...base, REAL_TRADING_ENABLED: "false", REAL_TRADING_VENUES: "ROBINHOOD_PONS_CURVE" });
    expect(config.realTrading.enabled).toBe(false);
    expect(config.realTrading.venues.size).toBe(0);
  });

  it("enables every known venue when switched on without a venue list", () => {
    const config = loadApiConfig({ ...base, REAL_TRADING_ENABLED: "true" });
    expect(config.realTrading.enabled).toBe(true);
    expect([...config.realTrading.venues].sort()).toEqual(["ROBINHOOD_PONS_CURVE", "ROBINHOOD_UNISWAP_V4"]);
  });

  it("enables only the venues named", () => {
    const config = loadApiConfig({ ...base, REAL_TRADING_ENABLED: "true", REAL_TRADING_VENUES: "robinhood_pons_curve" });
    expect([...config.realTrading.venues]).toEqual(["ROBINHOOD_PONS_CURVE"]);
  });

  it("rejects an unknown venue name loudly, because a typo would silently disable a route", () => {
    expect(() => loadApiConfig({ ...base, REAL_TRADING_ENABLED: "true", REAL_TRADING_VENUES: "ROBINHOOD_PONS_CRUVE" })).toThrow(ApiConfigError);
  });

  it("rejects a non-boolean flag rather than treating it as false", () => {
    expect(() => loadApiConfig({ ...base, REAL_TRADING_ENABLED: "yes" })).toThrow(ApiConfigError);
  });
});
