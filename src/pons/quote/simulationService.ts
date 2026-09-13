/**
 * Phase 7D.3.2 §5 — execution simulation of a quote through the real route.
 *
 * A quote says what the trade should yield. A simulation runs it: the exact calldata a
 * wallet would submit, through the deployed UniversalRouter (or the real bonding curve),
 * at the quote's own pinned block, from a synthetic account whose code and balance are set
 * by an `eth_call` state override. The result is that account's measured balance change.
 *
 * Verified end to end: evm-verification/test/fork/PonsRouteSimulatorFork.t.sol on a fork,
 * and the same calldata against live providers returned the fork's exact output.
 *
 * Still not a claim about any particular wallet. It proves the ROUTE executes for this
 * size and minimum at this block; a real wallet also needs the balance, the Permit2
 * approval and a transaction that lands before the price moves.
 */

import { createHash } from "node:crypto";
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex, type StateOverride } from "viem";

import type { ChainCaller } from "../chainClient";
import simulatorArtifact from "./generated/routeSimulator.json";
import { NATIVE_CURRENCY, UNISWAP_V4_ROBINHOOD } from "./protocol";
import type { Limitation, PonsQuote } from "./quoteService";
import { encodeRouterExactInSingle, type PoolKeyHex } from "./v4Quote";

export const SIMULATION_CALCULATION_VERSION = "pons-v2-route-sim-1";

/** Synthetic account. Has no code or balance on chain; both come from the override. */
export const SIMULATION_ACCOUNT = "0x0000000000000000000000000000000051350001" as const;

const SIMULATOR_ABI = simulatorArtifact.abi as unknown as import("viem").Abi;
const SIMULATOR_CODE = simulatorArtifact.runtimeBytecode as Hex;

/**
 * Candidate base slots for an ERC-20 `balances` mapping, tried in order and accepted only
 * after `balanceOf` confirms the overridden value:
 *   0, 1, 2, 3 — plain inheritance orders; 0 is OpenZeppelin v5 ERC20 (verified for
 *                PonsV2LauncherToken, whose source inherits it first)
 *   51 (0x33)  — OpenZeppelin v4 ERC20Upgradeable: Initializable (slot 0) + ContextUpgradeable
 *                __gap[50] (1–50) precede _balances
 *   ERC-7201   — OpenZeppelin v5 ERC20Upgradeable namespace, recomputed as
 *                keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.ERC20")) - 1)) & ~0xff
 * A wrong candidate is harmless: it is accepted only if balanceOf returns the probe value.
 */
const BALANCE_SLOT_CANDIDATES: readonly Hex[] = [
  "0x0000000000000000000000000000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000000000000000000000000000003",
  "0x0000000000000000000000000000000000000000000000000000000000000033",
  "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00",
];

/**
 * Revert selectors a user can act on. Each is `cast sig` of the error as declared in the
 * verified source of the contract that raises it — never typed from memory.
 */
const KNOWN_REVERTS: Record<string, string> = {
  "0x8b063d73": "V4TooLittleReceived(uint256,uint256) — output fell below the minimum", // V4Router
  "0xd81b2f2e": "AllowanceExpired(uint256) — Permit2 approval missing or expired", // Permit2
  "0x71c4efed": "SlippageExceeded(uint256,uint256) — curve output fell below the minimum", // PonsV2BondingCurve
  "0x025ac17e": "CurveGraduated() — the curve no longer trades", // PonsV2BondingCurve
  "0x6190b2b0": "UnexpectedRevertBytes(bytes) — the pool rejected the swap", // V4Quoter / v4-periphery
};

export type SimulationOutcome =
  | {
      status: "SIMULATED" | "REVERTED";
      block: PonsQuote["block"];
      simulatedAt: string;
      method: "ETH_CALL_STATE_OVERRIDE";
      route: { kind: "UNIVERSAL_ROUTER" | "BONDING_CURVE"; target: string };
      account: string;
      simulator: { sourceSha256: string; runtimeCodeHash: string };
      inputBalanceOverride: { currency: string; slot: string | null };
      result: {
        success: boolean;
        spent: string;
        received: string;
        gasUsed: string;
        expectedOut: string;
        minimumOut: string;
        /** Same block, same inputs: a successful simulation should equal the quote exactly. */
        matchesQuote: boolean;
        revert: { selector: string; data: string; meaning: string | null } | null;
      };
      calculationVersion: string;
      limitations: Limitation[];
    }
  | { status: "UNSUPPORTED"; reason: "INPUT_BALANCE_OVERRIDE_UNVERIFIED" | "INPUT_BALANCE_OVERRIDE_NOT_APPLIED" | "QUOTE_NOT_SIMULATABLE"; detail: string; block: PonsQuote["block"] }
  | { status: "UNAVAILABLE"; reason: "RPC_UNAVAILABLE" | "PROVIDER_CAPABILITY" | "QUOTE_BLOCK_REORGED"; detail: string };

const LIMITATIONS: Limitation[] = [
  { code: "SYNTHETIC_ACCOUNT", message: "Simulated from a synthetic account funded by a state override, not from your wallet." },
  { code: "NO_WALLET_CHECKS", message: "Your wallet's balance, Permit2 approval and network are not checked." },
  { code: "PINNED_BLOCK", message: "Runs at the quote's block. A real transaction lands later, against whatever state exists then." },
  { code: "NOT_BROADCAST", message: "Nothing is signed or broadcast." },
];

const balanceSlotCache = new Map<string, Hex | null>();

function mappingSlot(holder: string, base: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [holder as Hex, base]));
}

function toWord(value: bigint): Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex;
}

async function findBalanceSlot(caller: ChainCaller, token: string, blockNumber: bigint): Promise<Hex | null | "UNAVAILABLE"> {
  const key = token.toLowerCase();
  if (balanceSlotCache.has(key)) return balanceSlotCache.get(key)!;

  const probe = 0x5151_5151_5151n;
  const data = encodeFunctionData({ abi: parseAbi(["function balanceOf(address) view returns (uint256)"]), functionName: "balanceOf", args: [SIMULATION_ACCOUNT] });
  for (const base of BALANCE_SLOT_CANDIDATES) {
    const slot = mappingSlot(SIMULATION_ACCOUNT, base);
    const result = await caller.call({
      to: token,
      data,
      blockNumber,
      stateOverride: [{ address: token as Hex, stateDiff: [{ slot, value: toWord(probe) }] }],
    });
    if (result.status === "UNAVAILABLE") return "UNAVAILABLE";
    if (result.data.kind !== "SUCCESS") continue;
    if (result.data.data.length >= 66 && BigInt(result.data.data.slice(0, 66)) === probe) {
      balanceSlotCache.set(key, base);
      return base;
    }
  }
  balanceSlotCache.set(key, null);
  return null;
}

/** Test seam: forget discovered layouts. */
export function resetBalanceSlotCache(): void {
  balanceSlotCache.clear();
}

export async function simulateQuote(quote: PonsQuote, deps: { caller: ChainCaller; now?: () => Date }): Promise<SimulationOutcome> {
  const now = deps.now ?? (() => new Date());
  const blockNumber = BigInt(quote.block.number);

  // The quote's block must still be canonical, or the simulation would describe state that
  // no longer exists while looking consistent with the quote.
  const ref = await deps.caller.getBlockRef(blockNumber);
  if (ref.status === "UNAVAILABLE") return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: `${ref.code}: ${ref.reason}` };
  if (ref.data.hash.toLowerCase() !== quote.block.hash.toLowerCase()) {
    return { status: "UNAVAILABLE", reason: "QUOTE_BLOCK_REORGED", detail: `block ${quote.block.number} no longer has the quoted hash` };
  }

  const amountIn = BigInt(quote.input.amount);
  const minimumOut = BigInt(quote.output.minimum);
  const inputCurrency = quote.input.currency.toLowerCase();
  const overrides: StateOverride = [{ address: SIMULATION_ACCOUNT, code: SIMULATOR_CODE, balance: inputCurrency === NATIVE_CURRENCY ? amountIn : 0n }];

  let balanceSlot: Hex | null = null;
  if (inputCurrency !== NATIVE_CURRENCY) {
    const found = await findBalanceSlot(deps.caller, inputCurrency, blockNumber);
    if (found === "UNAVAILABLE") return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: "balance layout probe failed" };
    if (found === null) {
      return {
        status: "UNSUPPORTED",
        reason: "INPUT_BALANCE_OVERRIDE_UNVERIFIED",
        detail: `could not verify a balance storage layout for ${quote.input.symbol ?? inputCurrency}; the route cannot be funded synthetically`,
        block: quote.block,
      };
    }
    balanceSlot = found;
    overrides.push({ address: inputCurrency as Hex, stateDiff: [{ slot: mappingSlot(SIMULATION_ACCOUNT, found), value: toWord(amountIn) }] });
  }

  let data: Hex;
  let route: { kind: "UNIVERSAL_ROUTER" | "BONDING_CURVE"; target: string };
  let functionName: "simulateRouter" | "simulateCurveBuy" | "simulateCurveSell";

  if (quote.venueState.kind === "pool") {
    const poolKey = quote.venueState.poolKey as PoolKeyHex;
    const zeroForOne = inputCurrency === poolKey.currency0.toLowerCase();
    const { commands, inputs } = encodeRouterExactInSingle({ poolKey, zeroForOne, amountIn, minimumOut });
    functionName = "simulateRouter";
    route = { kind: "UNIVERSAL_ROUTER", target: UNISWAP_V4_ROBINHOOD.universalRouter };
    data = encodeFunctionData({
      abi: SIMULATOR_ABI,
      functionName,
      args: [UNISWAP_V4_ROBINHOOD.universalRouter, inputCurrency, quote.output.currency, amountIn, commands, inputs, BigInt(quote.block.timestamp) + 600n],
    });
  } else if (quote.venueState.kind === "curve") {
    const curve = quote.venueState.curve;
    route = { kind: "BONDING_CURVE", target: curve };
    const pairToken = quote.side === "buy" ? quote.input.currency : quote.output.currency;
    functionName = quote.side === "buy" ? "simulateCurveBuy" : "simulateCurveSell";
    data = encodeFunctionData({ abi: SIMULATOR_ABI, functionName, args: [curve, pairToken, quote.tokenAddress, amountIn, minimumOut] });
  } else {
    return { status: "UNSUPPORTED", reason: "QUOTE_NOT_SIMULATABLE", detail: "unknown venue state", block: quote.block };
  }

  const call = await deps.caller.call({ to: SIMULATION_ACCOUNT, data, blockNumber, stateOverride: overrides });
  if (call.status === "UNAVAILABLE") return { status: "UNAVAILABLE", reason: "RPC_UNAVAILABLE", detail: `${call.code}: ${call.reason}` };
  if (call.data.kind === "UNSUPPORTED_CAPABILITY") {
    return { status: "UNAVAILABLE", reason: "PROVIDER_CAPABILITY", detail: "no configured provider accepted the state override" };
  }
  if (call.data.kind === "REVERTED") {
    // The simulator catches the route's revert itself; the outer call reverting means the
    // simulator could not even run (e.g. an approve on a non-standard token).
    return { status: "UNSUPPORTED", reason: "QUOTE_NOT_SIMULATABLE", detail: `simulator reverted (${call.data.data.slice(0, 10)})`, block: quote.block };
  }

  const r = decodeFunctionResult({ abi: SIMULATOR_ABI, functionName, data: call.data.data }) as {
    success: boolean;
    inputBalanceBefore: bigint;
    spent: bigint;
    received: bigint;
    gasUsed: bigint;
    revertData: Hex;
  };

  if (r.inputBalanceBefore !== amountIn) {
    return {
      status: "UNSUPPORTED",
      reason: "INPUT_BALANCE_OVERRIDE_NOT_APPLIED",
      detail: `synthetic balance was ${r.inputBalanceBefore}, expected ${amountIn}`,
      block: quote.block,
    };
  }

  const selector = r.revertData.length >= 10 ? r.revertData.slice(0, 10) : null;
  return {
    status: r.success ? "SIMULATED" : "REVERTED",
    block: quote.block,
    simulatedAt: now().toISOString(),
    method: "ETH_CALL_STATE_OVERRIDE",
    route,
    account: SIMULATION_ACCOUNT,
    simulator: {
      sourceSha256: simulatorArtifact.sourceSha256,
      runtimeCodeHash: createHash("sha256").update(Buffer.from(SIMULATOR_CODE.slice(2), "hex")).digest("hex"),
    },
    inputBalanceOverride: { currency: inputCurrency, slot: balanceSlot },
    result: {
      success: r.success,
      spent: r.spent.toString(),
      received: r.received.toString(),
      gasUsed: r.gasUsed.toString(),
      expectedOut: quote.output.expected,
      minimumOut: quote.output.minimum,
      matchesQuote: r.success && r.received.toString() === quote.output.expected,
      revert: r.success ? null : { selector: selector ?? "0x", data: r.revertData, meaning: selector ? (KNOWN_REVERTS[selector] ?? null) : null },
    },
    calculationVersion: SIMULATION_CALCULATION_VERSION,
    limitations: LIMITATIONS,
  };
}

