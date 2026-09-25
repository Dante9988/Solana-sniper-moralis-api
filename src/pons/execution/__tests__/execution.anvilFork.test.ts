/**
 * Phase 7E.1 §22 (FORK/LOCAL EVM) — real BUY and SELL on both venues, against a real fork
 * of Robinhood Chain, driven by the exact calldata the execution service produces.
 *
 * Nothing is mocked. The fork carries the deployed PonsV2 factory, the real bonding curves,
 * the real Uniswap V4 PoolManager, StateView, V4Quoter, UniversalRouter and Permit2, all at
 * their mainnet addresses with their mainnet bytecode and state. The only thing this test
 * supplies is a funded wallet, which anvil provides.
 *
 * The chain of custody is the point:
 *
 *   quotePonsV2 (real)  ->  venue.buildTransaction (real)  ->  eth_sendTransaction of
 *   exactly that {to, data, value}  ->  real receipt  ->  venue.reconcile (real)
 *
 * No step substitutes a fixture for the step before it. If the calldata the production
 * builder emits is wrong, the transaction reverts here.
 *
 * Nothing touches mainnet beyond read-only fork sourcing: anvil serves every write from its
 * own in-memory state, and no transaction produced here is ever broadcast (§21).
 *
 * Opt-in; needs the `anvil` binary and an archive-capable Robinhood RPC:
 *   PONS_RUN_EXECUTION_FORK_TEST=true npx vitest run src/pons/execution/__tests__/execution.anvilFork.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  http,
  parseAbi,
  publicActions,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PonsChainClient } from "../../chainClient";
import { loadPonsV2Config, type RobinhoodChainConfig } from "../../config";
import { ROBINHOOD_CHAIN_ID, UNISWAP_V4_ROBINHOOD } from "../../quote/protocol";
import { quotePonsV2, type PonsQuote } from "../../quote/quoteService";
import { PERMIT2_ABI } from "../executionProtocol";
import { RobinhoodPonsExecutionVenue } from "../ponsCurveVenue";
import { RobinhoodUniswapV4ExecutionVenue } from "../uniswapV4Venue";
import type { ExecutionPlan, ReceiptFacts, SpotExecutionVenue, WalletProbe } from "../venue";

const RUN = process.env.PONS_RUN_EXECUTION_FORK_TEST === "true";
const PORT = Number(process.env.EXECUTION_FORK_PORT ?? 8648);
const RPC_URL = `http://127.0.0.1:${PORT}`;

/**
 * The test wallet, derived as keccak256("onlypump-phase-7e1-fork-test").
 *
 * Deliberately NOT one of Foundry's well-known dev accounts, and that is not fussiness.
 * Measured on Robinhood Chain mainnet on 2026-09-25: **all ten** standard Foundry/Hardhat
 * dev addresses carry a deployed 23-byte contract that forwards every incoming wei to
 * 0xcc04506d439d338bde8ebbb074f17a54b7673b95. Someone has sprayed sweepers across the
 * usual test addresses on this chain.
 *
 * On a fork that is silently destructive. A sell paid to 0xf39Fd6…2266 succeeds, emits a
 * correct CurveSell naming it as recipient, and leaves the seller's balance unchanged —
 * which reads exactly like a broken payout until you pull the call trace. It also means
 * anyone using a default test key against Robinhood Chain for real loses the funds.
 *
 * This key is test-only, funded solely on the throwaway fork via anvil_setBalance, and
 * never used off anvil. The no-code assertion below is a standing guard, not decoration.
 */
const TEST_PRIVATE_KEY = "0x14e1d63921350f7edd5a6d2a00d7e8e718c54e5f38586e303231b8e1f94e2599" as const;

/** Verified live on 2026-09-25: both quote, both are native-ETH quoted, both are liquid. */
const SOCIAL = "0x923bfb0eb05e918f8b42db5503ded94a44dca4ff"; // ungraduated -> bonding curve
const RBD = "0xb41c7ac9d46a980f8bdf1894b392a2a07ec9992a"; // graduated -> Uniswap V4

const BUY_AMOUNT = 10n ** 16n; // 0.01 ETH
const SLIPPAGE_BPS = 300;

const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function symbol() view returns (string)",
]);

const forkChain = defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: "robinhood-fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

async function waitForReady(): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) {
        const body = (await res.json()) as { result?: string };
        if (body.result) return;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`anvil did not fork Robinhood Chain on ${RPC_URL} within 90s`);
}

/** The Pons factory address, from the environment or .env, without polluting process.env. */
function ponsEnv(): NodeJS.ProcessEnv {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const parsed = require("dotenv").parse(require("node:fs").readFileSync(".env"));
    return { ...parsed, ...process.env };
  } catch {
    return process.env;
  }
}

/**
 * The endpoint anvil forks from.
 *
 * Order matters. anvil fetches state lazily, one account and slot at a time, so a fork run
 * makes far more requests than an ordinary read — and `rpc-robinhood.blockmachine.io`
 * answers with HTTP 429 (60 compute units per minute) part way through, which surfaces as
 * an opaque "failed to get account" mid-test. The higher-throughput provider goes first
 * and the wide-range one is the fallback.
 */
function forkUpstream(): string | undefined {
  const env = ponsEnv();
  return process.env.EXECUTION_FORK_RPC || env.ROBINHOOD_RPC_HTTPS3 || env.DEAFULT_RPC_HTTPS || undefined;
}

async function headBlock(url: string): Promise<bigint> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "OnlyPumpBackend/1.0" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const body = (await res.json()) as { result: string };
  return BigInt(body.result);
}

/** Everything this test measures, printed at the end as the PR's machine-readable evidence. */
interface Leg {
  venue: string;
  side: "buy" | "sell";
  token: string;
  symbol: string | null;
  route: { kind: string; target: string };
  poolId: string | null;
  quoteBlock: string;
  selector: string;
  approvals: { kind: string; spender: string; required: string; txHash: string | null }[];
  amountIn: string;
  expectedOut: string;
  minimumOut: string;
  ethBefore: string;
  ethAfter: string;
  tokenBefore: string;
  tokenAfter: string;
  gasUsed: string;
  effectiveGasPrice: string | null;
  /** Gas paid across EVERY transaction in the leg, approvals included. */
  totalGasCost: string;
  txHash: string;
  receiptStatus: string;
  reconciled: { status: string; actualInput: string | null; actualOutput: string | null; matchedWallet: boolean };
}

const evidence: Leg[] = [];

describe.skipIf(!RUN)("Phase 7E.1 execution — real Robinhood Chain fork, real contracts, production calldata", () => {
  let anvil: ChildProcess;
  let forkBlock: bigint;
  let chainConfig: RobinhoodChainConfig;
  let factoryAddress: string;

  let account: ReturnType<typeof privateKeyToAccount>;
  let wallet: ReturnType<typeof createWalletClient> & ReturnType<typeof publicActions>;
  let publicClient: PublicClient;
  let caller: PonsChainClient;
  let probe: WalletProbe;

  const curveVenue = new RobinhoodPonsExecutionVenue();
  const v4Venue = new RobinhoodUniswapV4ExecutionVenue();

  beforeAll(async () => {
    // vitest does not load .env, and the RPC URL carries an API key. Read the file rather
    // than importing it into process.env, so nothing leaks into other test workers or logs.
    const upstream = forkUpstream();
    if (!upstream) throw new Error("set EXECUTION_FORK_RPC, ROBINHOOD_RPC_HTTPS3 or DEAFULT_RPC_HTTPS to an archive-capable Robinhood Chain RPC");

    forkBlock = process.env.EXECUTION_FORK_BLOCK ? BigInt(process.env.EXECUTION_FORK_BLOCK) : (await headBlock(upstream)) - 30n;

    anvil = spawn(
      "anvil",
      [
        "--fork-url",
        upstream,
        "--fork-block-number",
        forkBlock.toString(),
        "--port",
        String(PORT),
        "--silent",
        // Lazy state fetching bursts; ride out a provider's rate limit instead of failing
        // the run with an opaque "failed to get account".
        "--retries",
        "10",
        "--fork-retry-backoff",
        "5",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    // Without this the pipe fills and anvil blocks, and a fork failure is invisible.
    let anvilStderr = "";
    anvil.stderr?.on("data", (chunk: Buffer) => {
      anvilStderr += chunk.toString();
    });
    anvil.on("exit", (code) => {
      if (code !== 0 && code !== null) anvilStderr += `\nanvil exited with code ${code}`;
    });
    try {
      await waitForReady();
    } catch (error) {
      throw new Error(`${(error as Error).message}\nanvil stderr:\n${anvilStderr || "(empty)"}`);
    }

    publicClient = createPublicClient({ chain: forkChain, transport: http(RPC_URL) }) as PublicClient;

    account = privateKeyToAccount(TEST_PRIVATE_KEY);
    // A wallet with code is not a wallet: anything paid to it can be swept before the test
    // ever sees it, and every balance assertion below would silently measure the wrong thing.
    const walletCode = await publicClient.getCode({ address: account.address });
    expect(walletCode ?? "0x", `${account.address} must carry no code on the forked chain`).toBe("0x");
    wallet = createWalletClient({ account, chain: forkChain, transport: http(RPC_URL) }).extend(publicActions) as typeof wallet;

    // anvil only pre-funds its own default indices; fund whichever one we settled on.
    await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [account.address, "0x21e19e0c9bab2400000"] }),
    });

    chainConfig = Object.freeze({
      ...({} as RobinhoodChainConfig),
      chainId: ROBINHOOD_CHAIN_ID,
      rpcHttpUrl: RPC_URL,
    }) as RobinhoodChainConfig;

    // The real production client, pointed at the fork. Not a test double.
    caller = new PonsChainClient({ config: chainConfig });
    factoryAddress = loadPonsV2Config(ponsEnv()).factoryAddress;

    probe = {
      async getBalance(address) {
        try {
          return { status: "AVAILABLE", data: await publicClient.getBalance({ address: address as Hex }), source: "fork", fetchedAt: new Date(), attempts: 1 };
        } catch (error) {
          return { status: "UNAVAILABLE", source: "fork", fetchedAt: new Date(), code: "RPC_ERROR", reason: (error as Error).message, attempts: 1 };
        }
      },
      async estimateGas(params) {
        try {
          const gas = await publicClient.estimateGas({ account: params.from as Hex, to: params.to as Hex, data: params.data, value: params.value });
          return { status: "AVAILABLE", data: gas, source: "fork", fetchedAt: new Date(), attempts: 1 };
        } catch (error) {
          // Expected before an approval is signed; the plan then leaves the limit to the wallet.
          return { status: "UNAVAILABLE", source: "fork", fetchedAt: new Date(), code: "RPC_ERROR", reason: (error as Error).message, attempts: 1 };
        }
      },
    };
  }, 180_000);

  afterAll(() => {
    anvil?.kill();
    if (evidence.length) {

      console.log("\n=== PHASE 7E.1 FORK EVIDENCE ===\n" + JSON.stringify({ forkBlock: forkBlock?.toString(), wallet: account.address, legs: evidence }, null, 2));
    }
  });

  async function tokenBalance(token: string, owner: string): Promise<bigint> {
    return publicClient.readContract({ address: token as Hex, abi: ERC20, functionName: "balanceOf", args: [owner as Hex] });
  }

  async function quoteOn(token: string, side: "buy" | "sell", amountIn: bigint): Promise<PonsQuote> {
    const outcome = await quotePonsV2({ tokenAddress: token, side, amountIn, slippageBps: SLIPPAGE_BPS }, { caller, factoryAddress });
    if (outcome.status !== "QUOTED") throw new Error(`quote ${side} ${token} -> ${outcome.status} ${JSON.stringify(outcome)}`);
    return outcome.quote;
  }

  /** `now` is pinned just inside the quote's own window so wall-clock expiry never flakes. */
  function justAfter(quote: PonsQuote): () => Date {
    return () => new Date(Date.parse(quote.quotedAt) + 1_000);
  }

  async function build(venue: SpotExecutionVenue, quote: PonsQuote): Promise<ExecutionPlan> {
    const outcome = await venue.buildTransaction({ quote, walletAddress: account.address }, { caller, probe, now: justAfter(quote) });
    if (outcome.status !== "BUILT") throw new Error(`build -> ${outcome.status} ${JSON.stringify(outcome)}`);
    return outcome.plan;
  }

  /** Sends exactly what the plan says. Gas is the wallet's business, so it is left to viem when null. */
  async function send(tx: { to: string; data: Hex; value: string; gasLimit: string | null }): Promise<TransactionReceipt> {
    const hash = await wallet.sendTransaction({
      account,
      chain: forkChain,
      to: tx.to as Hex,
      data: tx.data,
      value: BigInt(tx.value),
      ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
    });
    return wallet.waitForTransactionReceipt({ hash });
  }

  function receiptFacts(receipt: TransactionReceipt): ReceiptFacts {
    return {
      status: receipt.status === "success" ? "success" : "reverted",
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice ?? null,
      logs: receipt.logs.map((log) => ({ address: log.address, topics: [...log.topics], data: log.data })),
    };
  }

  /**
   * Run one leg end to end and record what happened.
   *
   * The assertions common to every leg live here so a venue cannot pass with a weaker
   * check than the other: the receipt succeeded, the token balance moved by at least the
   * minimum the user was promised, ETH moved the right way, and reconciliation agrees with
   * the measured balances rather than with the quote.
   */
  async function runLeg(params: { venue: SpotExecutionVenue; quote: PonsQuote; token: string; symbol: string | null }): Promise<Leg> {
    const { venue, quote, token } = params;
    const plan = await build(venue, quote);

    const ethBefore = await publicClient.getBalance({ address: account.address });
    const tokenBefore = await tokenBalance(token, account.address);

    const approvals: Leg["approvals"] = [];
    let totalGasCost = 0n;
    for (const approval of plan.approvals) {
      if (approval.satisfied) {
        approvals.push({ kind: approval.kind, spender: approval.spender, required: approval.required, txHash: null });
        continue;
      }
      const receipt = await send(approval.transaction);
      expect(receipt.status, `${approval.kind} approval must succeed`).toBe("success");
      totalGasCost += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
      approvals.push({ kind: approval.kind, spender: approval.spender, required: approval.required, txHash: receipt.transactionHash });
    }

    const receipt = await send(plan.swap);
    totalGasCost += receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n);
    expect(receipt.status, `${plan.venue} ${plan.side} swap must succeed`).toBe("success");

    const ethAfter = await publicClient.getBalance({ address: account.address });
    const tokenAfter = await tokenBalance(token, account.address);

    const reconciled = venue.reconcile({ plan, receipt: receiptFacts(receipt) });
    expect(reconciled.status).toBe("CONFIRMED");

    return {
      venue: plan.venue,
      side: plan.side,
      token,
      symbol: params.symbol,
      route: plan.route,
      poolId: plan.poolId,
      quoteBlock: plan.quoteBlock.number,
      selector: plan.swap.data.slice(0, 10),
      approvals,
      amountIn: quote.input.amount,
      expectedOut: plan.expectedOutput,
      minimumOut: plan.minimumOutput,
      ethBefore: ethBefore.toString(),
      ethAfter: ethAfter.toString(),
      tokenBefore: tokenBefore.toString(),
      tokenAfter: tokenAfter.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice?.toString() ?? null,
      totalGasCost: totalGasCost.toString(),
      txHash: receipt.transactionHash,
      receiptStatus: receipt.status,
      reconciled: {
        status: reconciled.status,
        actualInput: reconciled.actualInput,
        actualOutput: reconciled.actualOutput,
        matchedWallet: reconciled.matchedWallet,
      },
    };
  }

  it("forked the real Robinhood Chain, with the real venue contracts present", async () => {
    expect(await publicClient.getChainId()).toBe(ROBINHOOD_CHAIN_ID);
    for (const [name, address] of [
      ["PoolManager", UNISWAP_V4_ROBINHOOD.poolManager],
      ["UniversalRouter", UNISWAP_V4_ROBINHOOD.universalRouter],
      ["Permit2", UNISWAP_V4_ROBINHOOD.permit2],
      ["StateView", UNISWAP_V4_ROBINHOOD.stateView],
      ["V4Quoter", UNISWAP_V4_ROBINHOOD.v4Quoter],
    ] as const) {
      const code = await publicClient.getCode({ address: address as Hex });
      expect(code, `${name} must be deployed on the fork`).toBeTruthy();
      expect(code!.length, `${name} must carry real bytecode`).toBeGreaterThan(2);
    }
  }, 120_000);

  it("PONS CURVE — buys SOCIAL for real ETH, and the wallet ends up holding the tokens", async () => {
    const quote = await quoteOn(SOCIAL, "buy", BUY_AMOUNT);
    expect(quote.venue).toBe("PONS_V2_BONDING_CURVE");

    const leg = await runLeg({ venue: curveVenue, quote, token: SOCIAL, symbol: quote.output.symbol });
    evidence.push(leg);

    const received = BigInt(leg.tokenAfter) - BigInt(leg.tokenBefore);
    const ethSpent = BigInt(leg.ethBefore) - BigInt(leg.ethAfter);

    // A native buy costs exactly the input plus gas — nothing else may leave the wallet.
    expect(ethSpent).toBe(BUY_AMOUNT + BigInt(leg.totalGasCost));
    expect(received).toBeGreaterThanOrEqual(BigInt(leg.minimumOut));
    // The curve's own event must agree with the measured balance change.
    expect(leg.reconciled.actualOutput).toBe(received.toString());
    expect(leg.reconciled.actualInput).toBe(BUY_AMOUNT.toString());
    expect(leg.reconciled.matchedWallet).toBe(true);
    // The production builder called buy(uint256,uint256,address).
    expect(leg.selector).toBe("0x59a87bc1");
    expect(leg.approvals).toEqual([]); // native input needs none
  }, 180_000);

  it("PONS CURVE — sells SOCIAL back, taking the exact ERC-20 approval it asked for", async () => {
    const held = await tokenBalance(SOCIAL, account.address);
    expect(held).toBeGreaterThan(0n);
    const sellAmount = held / 2n;

    const quote = await quoteOn(SOCIAL, "sell", sellAmount);
    const curve = (quote.venueState as { curve: string }).curve;

    const allowanceBefore = await publicClient.readContract({ address: SOCIAL as Hex, abi: ERC20, functionName: "allowance", args: [account.address, curve as Hex] });
    const leg = await runLeg({ venue: curveVenue, quote, token: SOCIAL, symbol: quote.input.symbol });
    evidence.push(leg);

    // One approval, for exactly the sell amount — never unlimited.
    expect(leg.approvals).toHaveLength(1);
    expect(leg.approvals[0].kind).toBe("ERC20_TO_CURVE");
    expect(leg.approvals[0].required).toBe(sellAmount.toString());
    expect(allowanceBefore).toBe(0n);

    const spent = BigInt(leg.tokenBefore) - BigInt(leg.tokenAfter);
    expect(spent).toBe(sellAmount);

    // ethBefore is captured before the approval transactions, so their gas counts too.
    const ethReceived = BigInt(leg.ethAfter) - BigInt(leg.ethBefore) + BigInt(leg.totalGasCost);
    expect(ethReceived).toBeGreaterThanOrEqual(BigInt(leg.minimumOut));
    expect(leg.reconciled.actualOutput).toBe(ethReceived.toString());
    expect(leg.selector).toBe("0xd04c6983"); // sell(uint256,uint256,address)

    // An exact approval is consumed exactly: nothing is left behind for a later spender.
    const allowanceAfter = await publicClient.readContract({ address: SOCIAL as Hex, abi: ERC20, functionName: "allowance", args: [account.address, curve as Hex] });
    expect(allowanceAfter).toBe(0n);
  }, 180_000);

  it("UNISWAP V4 — buys RBD through the real UniversalRouter", async () => {
    const quote = await quoteOn(RBD, "buy", BUY_AMOUNT);
    expect(quote.venue).toBe("PONS_V2_UNISWAP_V4");

    const leg = await runLeg({ venue: v4Venue, quote, token: RBD, symbol: quote.output.symbol });
    evidence.push(leg);

    expect(leg.route.target.toLowerCase()).toBe(UNISWAP_V4_ROBINHOOD.universalRouter);
    expect(leg.selector).toBe("0x3593564c"); // execute(bytes,bytes[],uint256)
    expect(leg.approvals).toEqual([]); // native input

    const received = BigInt(leg.tokenAfter) - BigInt(leg.tokenBefore);
    expect(BigInt(leg.ethBefore) - BigInt(leg.ethAfter)).toBe(BUY_AMOUNT + BigInt(leg.totalGasCost));
    expect(received).toBeGreaterThanOrEqual(BigInt(leg.minimumOut));

    // PoolManager's Swap is gross of the Pons hook's fee, so the wallet receives slightly
    // less than the event reports. Asserting the direction of that gap is the honest check:
    // equality would mean the hook fee had silently vanished.
    expect(BigInt(leg.reconciled.actualOutput!)).toBeGreaterThanOrEqual(received);
    expect(leg.reconciled.actualInput).toBe(BUY_AMOUNT.toString());
  }, 180_000);

  it("UNISWAP V4 — sells RBD, taking BOTH approvals, and Permit2 decrements exactly what it spent", async () => {
    const held = await tokenBalance(RBD, account.address);
    expect(held).toBeGreaterThan(0n);
    const sellAmount = held / 2n;

    const quote = await quoteOn(RBD, "sell", sellAmount);
    const router = UNISWAP_V4_ROBINHOOD.universalRouter as Hex;

    const permitBefore = await publicClient.readContract({
      address: UNISWAP_V4_ROBINHOOD.permit2 as Hex,
      abi: PERMIT2_ABI,
      functionName: "allowance",
      args: [account.address, RBD as Hex, router],
    });
    expect(permitBefore[0]).toBe(0n);

    const leg = await runLeg({ venue: v4Venue, quote, token: RBD, symbol: quote.input.symbol });
    evidence.push(leg);

    // The two-approval path, in order, each for exactly the input amount.
    expect(leg.approvals.map((a) => a.kind)).toEqual(["ERC20_TO_PERMIT2", "PERMIT2_TO_ROUTER"]);
    expect(leg.approvals[0].spender.toLowerCase()).toBe(UNISWAP_V4_ROBINHOOD.permit2);
    expect(leg.approvals[1].spender.toLowerCase()).toBe(UNISWAP_V4_ROBINHOOD.permit2 === router ? router : router.toLowerCase());
    for (const approval of leg.approvals) expect(approval.required).toBe(sellAmount.toString());

    const spent = BigInt(leg.tokenBefore) - BigInt(leg.tokenAfter);
    expect(spent).toBe(sellAmount);

    const ethReceived = BigInt(leg.ethAfter) - BigInt(leg.ethBefore) + BigInt(leg.totalGasCost);
    expect(ethReceived).toBeGreaterThanOrEqual(BigInt(leg.minimumOut));

    // Permit2 decrements the allowance by what the router actually pulled. An exact
    // approval therefore leaves nothing behind.
    const permitAfter = await publicClient.readContract({
      address: UNISWAP_V4_ROBINHOOD.permit2 as Hex,
      abi: PERMIT2_ABI,
      functionName: "allowance",
      args: [account.address, RBD as Hex, router],
    });
    expect(permitAfter[0]).toBe(0n);
    // The ERC-20 leg is consumed too: Permit2 pulled exactly the approved amount.
    const erc20After = await publicClient.readContract({ address: RBD as Hex, abi: ERC20, functionName: "allowance", args: [account.address, UNISWAP_V4_ROBINHOOD.permit2 as Hex] });
    expect(erc20After).toBe(0n);
  }, 180_000);

  it("PONS CURVE — enforces slippage: a minimum the curve cannot meet reverts on chain", async () => {
    const quote = await quoteOn(SOCIAL, "buy", BUY_AMOUNT);
    const greedy: PonsQuote = {
      ...quote,
      output: { ...quote.output, minimum: (BigInt(quote.output.expected) * 2n).toString() },
    };
    const plan = await build(curveVenue, greedy);

    // The minimum really is in the bytes the wallet would sign.
    const [, minimum] = decodeFunctionData({
      abi: parseAbi(["function buy(uint256,uint256,address) payable returns (uint256)"]),
      data: plan.swap.data,
    }).args as [bigint, bigint, string];
    expect(minimum).toBe(BigInt(quote.output.expected) * 2n);

    const before = await tokenBalance(SOCIAL, account.address);
    const hash = await wallet.sendTransaction({ account, chain: forkChain, to: plan.swap.to as Hex, data: plan.swap.data, value: BigInt(plan.swap.value), gas: 1_500_000n });
    const receipt = await wallet.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe("reverted");
    expect(await tokenBalance(SOCIAL, account.address)).toBe(before);

    // And the venue reads the failure back as REVERTED, without inventing amounts.
    const reconciled = curveVenue.reconcile({ plan, receipt: receiptFacts(receipt) });
    expect(reconciled.status).toBe("REVERTED");
    expect(reconciled.actualOutput).toBeNull();
    expect(reconciled.failureReason).toBeTruthy();
  }, 180_000);

  it("UNISWAP V4 — enforces slippage: an unreachable minimum reverts through the router", async () => {
    const quote = await quoteOn(RBD, "buy", BUY_AMOUNT);
    const greedy: PonsQuote = {
      ...quote,
      output: { ...quote.output, minimum: (BigInt(quote.output.expected) * 2n).toString() },
    };
    const plan = await build(v4Venue, greedy);

    const before = await tokenBalance(RBD, account.address);
    const hash = await wallet.sendTransaction({ account, chain: forkChain, to: plan.swap.to as Hex, data: plan.swap.data, value: BigInt(plan.swap.value), gas: 1_500_000n });
    const receipt = await wallet.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe("reverted");
    expect(await tokenBalance(RBD, account.address)).toBe(before);

    const reconciled = v4Venue.reconcile({ plan, receipt: receiptFacts(receipt) });
    expect(reconciled.status).toBe("REVERTED");
    expect(reconciled.actualOutput).toBeNull();
  }, 180_000);

  it("UNISWAP V4 — without the Permit2 approval the swap fails, which is what makes the approval step real", async () => {
    const held = await tokenBalance(RBD, account.address);
    const sellAmount = held / 4n;
    expect(sellAmount).toBeGreaterThan(0n);

    const quote = await quoteOn(RBD, "sell", sellAmount);
    const plan = await build(v4Venue, quote);
    expect(plan.approvals.every((a) => !a.satisfied)).toBe(true);

    // Skip the approvals the plan asked for and send the swap anyway.
    const before = await tokenBalance(RBD, account.address);
    const hash = await wallet.sendTransaction({ account, chain: forkChain, to: plan.swap.to as Hex, data: plan.swap.data, value: 0n, gas: 1_500_000n });
    const receipt = await wallet.waitForTransactionReceipt({ hash });

    expect(receipt.status).toBe("reverted");
    expect(await tokenBalance(RBD, account.address)).toBe(before);
  }, 180_000);

  it("refuses to build against a quote whose block is no longer canonical", async () => {
    const quote = await quoteOn(SOCIAL, "buy", BUY_AMOUNT);
    const tampered: PonsQuote = { ...quote, block: { ...quote.block, hash: `0x${"9".repeat(64)}` } };
    const outcome = await curveVenue.buildTransaction({ quote: tampered, walletAddress: account.address }, { caller, probe, now: justAfter(quote) });
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "QUOTE_BLOCK_REORGED" });
  }, 120_000);

  it("refuses to build for a wallet that does not hold the token it would sell", async () => {
    // A perfectly valid sell — for a different, empty wallet. The refusal must come from
    // the balance check, not from the curve declining the size.
    const held = await tokenBalance(SOCIAL, account.address);
    const quote = await quoteOn(SOCIAL, "sell", held / 4n);
    const empty = privateKeyToAccount(`0x${"7".repeat(64)}`).address;
    expect(await tokenBalance(SOCIAL, empty)).toBe(0n);

    const outcome = await curveVenue.buildTransaction({ quote, walletAddress: empty }, { caller, probe, now: justAfter(quote) });
    expect(outcome).toMatchObject({ status: "REFUSED", reason: "INSUFFICIENT_BALANCE" });
  }, 120_000);
});
