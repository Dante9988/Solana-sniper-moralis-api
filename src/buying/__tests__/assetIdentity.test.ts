import { describe, expect, it } from "vitest";

import {
  AssetIdentityError,
  NATIVE_BTC,
  WBTC_ETHEREUM,
  assetKey,
  normalizeAsset,
  purchaseDisclosure,
  sameAsset,
  type AssetIdentity,
} from "../assetIdentity";

/**
 * Phase 7D.5.1 — a symbol never authorizes a purchase.
 *
 * "BTC" is three different assets depending on network and custody, and a buy flow that
 * resolves by symbol will eventually deliver the wrong one. These tests are the guard.
 */

const USDC_SOL: AssetIdentity = {
  network: "solana",
  kind: "token",
  address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  decimals: 6,
  symbol: "USDC",
  name: "USD Coin",
};

describe("asset identity", () => {
  it("keys on network + address, so two chains can never collide", () => {
    const sameAddressDifferentChain: AssetIdentity = { ...WBTC_ETHEREUM, network: "robinhood" };
    expect(assetKey(WBTC_ETHEREUM)).not.toBe(assetKey(sameAddressDifferentChain));
    expect(sameAsset(WBTC_ETHEREUM, sameAddressDifferentChain)).toBe(false);
  });

  it("never treats WBTC and native BTC as the same asset", () => {
    // The substitution this whole module exists to prevent.
    expect(sameAsset(WBTC_ETHEREUM, NATIVE_BTC)).toBe(false);
    expect(WBTC_ETHEREUM.network).toBe("ethereum");
    expect(NATIVE_BTC.network).toBe("bitcoin");
  });

  it("discloses WBTC as wrapped, naming the network, without claiming to be Bitcoin", () => {
    const text = purchaseDisclosure(WBTC_ETHEREUM)!;
    expect(text).toMatch(/Wrapped Bitcoin \(WBTC\)/);
    expect(text).toMatch(/Ethereum/);
    expect(text).toMatch(/not native Bitcoin/i);
  });

  it("discloses a tokenized equity as not being a share", () => {
    const spy: AssetIdentity = {
      network: "robinhood",
      kind: "tokenized_equity",
      address: "0x117cc2133c37b721f49de2a7a74833232b3b4c0c",
      decimals: 18,
      symbol: "SPY",
      name: "SPDR S&P 500 ETF Trust (tokenized)",
    };
    const text = purchaseDisclosure(spy)!;
    expect(text).toMatch(/not a share/i);
    expect(text).toMatch(/no shareholder rights/i);
  });

  it("discloses a perp as not being ownership", () => {
    const perp: AssetIdentity = { network: "ethereum", kind: "perp", address: null, decimals: 18, symbol: "BTC-PERP", name: "BTC perpetual" };
    expect(purchaseDisclosure(perp)).toMatch(/not ownership/i);
  });

  it("says nothing extra for an ordinary token", () => {
    expect(purchaseDisclosure(USDC_SOL)).toBeNull();
  });

  it("lowercases EVM addresses so checksummed and lowercase forms are one asset", () => {
    const checksummed: AssetIdentity = { ...WBTC_ETHEREUM, address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" };
    expect(normalizeAsset(checksummed).address).toBe(WBTC_ETHEREUM.address);
    expect(assetKey(normalizeAsset(checksummed))).toBe(assetKey(WBTC_ETHEREUM));
  });

  it("refuses an address that is not valid for its network", () => {
    // A Solana mint on an EVM network, and an EVM address as a Solana mint: both are the
    // kind of mix-up that reaches the user as a real-looking asset if it is not stopped.
    expect(() => normalizeAsset({ ...USDC_SOL, network: "ethereum" })).toThrow(AssetIdentityError);
    expect(() => normalizeAsset({ ...WBTC_ETHEREUM, network: "solana" })).toThrow(AssetIdentityError);
    expect(() => normalizeAsset({ ...USDC_SOL, address: "not-a-mint!" })).toThrow(AssetIdentityError);
  });

  it("refuses a non-native asset with no address, and a native asset carrying one", () => {
    expect(() => normalizeAsset({ ...USDC_SOL, address: null })).toThrow(AssetIdentityError);
    expect(() => normalizeAsset({ ...NATIVE_BTC, address: "0xabc" })).toThrow(AssetIdentityError);
  });

  it("refuses impossible decimals rather than mis-scaling every later amount", () => {
    expect(() => normalizeAsset({ ...USDC_SOL, decimals: -1 })).toThrow(AssetIdentityError);
    expect(() => normalizeAsset({ ...USDC_SOL, decimals: 6.5 })).toThrow(AssetIdentityError);
  });

  it("accepts a valid Solana mint unchanged — base58 is case-sensitive", () => {
    expect(normalizeAsset(USDC_SOL).address).toBe(USDC_SOL.address);
  });
});
