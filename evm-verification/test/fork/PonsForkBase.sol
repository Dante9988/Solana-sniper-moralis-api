// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";

/**
 * Phase 7D.3.2 §2 — shared setup for verification against the REAL Robinhood Chain
 * contracts at one pinned block.
 *
 * Nothing here is a stand-in. The PoolManager, PonsV2MemeHook, PonsV2LaunchFactory,
 * bonding curves, UniversalRouter, Permit2 and official V4Quoter are the bytecode deployed
 * on chain 4663, loaded lazily from the fork. The only contract this suite deploys is a
 * V4Quoter compiled from pinned v4-periphery source, and only to prove it is identical to
 * the official one.
 *
 * Contrast with test/QuoterHookDelta.t.sol, which uses v4-core's FeeTakingHook in a
 * fresh local PoolManager. Those are TEST-HOOK results. Everything under test/fork is an
 * ACTUAL-PONS result. The evidence files keep that distinction in their `source` field.
 *
 * Addresses: Uniswap v4 deployments page (Robinhood Chain: 4663), accessed 2026-09-13,
 * and Blockscout-verified contract names. Pons addresses are read from the factory's own
 * view functions in `setUp` and compared, so a redeployment fails loudly.
 */
abstract contract PonsForkBase is Test {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant CHAIN_ID = 4663;
    /// Pinned 2026-09-13T19:39:36Z. Hash re-checked across providers by scripts/fork-verify.sh.
    uint256 internal constant FORK_BLOCK = 62211539;
    bytes32 internal constant FORK_BLOCK_HASH = 0x6554d2c6d1a1b2f99b9782f9d4157c125b6d051129d859df0fdb4395751d4d25;
    /// Robinhood Chain is Arbitrum-based. There the NUMBER opcode returns the parent-chain
    /// block (`l1BlockNumber` in the RPC block header), and Foundry >= 1.8 emulates that on a
    /// fork, so `block.number` reads this value rather than FORK_BLOCK. Foundry 1.5 did not.
    uint256 internal constant FORK_PARENT_BLOCK = 25970664;
    /// Same under both conventions, so it is the in-EVM check that the fork is at the pin.
    uint256 internal constant FORK_BLOCK_TIMESTAMP = 1789328376;

    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant OFFICIAL_QUOTER = 0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94;
    address internal constant STATE_VIEW = 0xF3334192D15450CdD385c8B70e03f9A6bD9E673b;
    address internal constant UNIVERSAL_ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant PONS_V2_FACTORY = 0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e;
    address internal constant PONS_MEME_HOOK = 0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044;

    /// UniversalRouter Commands.V4_SWAP and v4-periphery Actions, from the router's own
    /// verified source (universal-router lib/v4-periphery/src/libraries/Actions.sol).
    uint8 internal constant CMD_V4_SWAP = 0x10;
    uint8 internal constant ACT_SWAP_EXACT_IN_SINGLE = 0x06;
    uint8 internal constant ACT_SWAP_EXACT_OUT_SINGLE = 0x08;
    uint8 internal constant ACT_SETTLE_ALL = 0x0c;
    uint8 internal constant ACT_TAKE_ALL = 0x0f;

    string internal constant EVIDENCE_DIR = "./evidence/";

    address internal trader;

    function setUp() public virtual {
        // fork-verify.sh passes --fork-url/--fork-block-number so Foundry's retry and
        // rate-limit settings apply. Running the file directly falls back to the env var.
        if (block.chainid != CHAIN_ID) {
            string memory rpc = vm.envOr("ROBINHOOD_FORK_RPC_URL", string(""));
            // A missing RPC must never look like a passing suite. Failing setUp fails every
            // test in the contract, and fork-verify.sh turns that into an explicit BLOCKED.
            require(bytes(rpc).length != 0, "BLOCKED: ROBINHOOD_FORK_RPC_URL is not set");
            vm.createSelectFork(rpc, FORK_BLOCK);
        }
        assertEq(block.chainid, CHAIN_ID, "fork is not Robinhood Chain");
        // Identity of the pinned block (number + hash) is verified against two providers by
        // scripts/fork-verify.sh before forking. Inside the EVM, the timestamp pins it under
        // either block-number convention; see FORK_PARENT_BLOCK.
        assertEq(block.timestamp, FORK_BLOCK_TIMESTAMP, "fork is not at the pinned block (timestamp)");
        assertTrue(block.number == FORK_BLOCK || block.number == FORK_PARENT_BLOCK, "fork is not at the pinned block (number)");

        // Identity: the factory must still point at the contracts this suite names.
        assertEq(IPonsFactory(PONS_V2_FACTORY).poolManager(), POOL_MANAGER, "factory.poolManager changed");
        assertEq(IPonsFactory(PONS_V2_FACTORY).memeHook(), PONS_MEME_HOOK, "factory.memeHook changed");
        assertEq(address(IV4Quoter(OFFICIAL_QUOTER).poolManager()), POOL_MANAGER, "quoter bound elsewhere");

        trader = makeAddr("fork-trader");
        // Gas price zero so a native balance delta is exactly the swap's value flow, not gas.
        vm.txGasPrice(0);
    }

    // ---------------------------------------------------------------------
    // Pool construction — from the factory's record, never hardcoded
    // ---------------------------------------------------------------------

    struct PonsPool {
        address token;
        address pairToken;
        PoolKey key;
        PoolId id;
        bool memecoinIsCurrency0;
        uint16 hookFeeBps;
        uint16 creatorTaxBps;
        uint8 phase;
    }

    function loadPool(address token) internal view returns (PonsPool memory p) {
        IPonsFactory.LaunchedToken memory lt = IPonsFactory(PONS_V2_FACTORY).getLaunchedToken(token);
        require(lt.exists, "factory does not know token");
        p.token = token;
        p.pairToken = lt.pairToken;
        p.phase = lt.phase;
        (address c0, address c1) = token < lt.pairToken ? (token, lt.pairToken) : (lt.pairToken, token);
        p.key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: lt.poolFee,
            tickSpacing: lt.tickSpacing,
            hooks: IHooks(PONS_MEME_HOOK)
        });
        p.id = p.key.toId();
        p.memecoinIsCurrency0 = c0 == token;

        // Fee terms as the HOOK recorded them at registerPool — the values _afterSwap
        // actually charges. Not inferred from permission flags or from the factory's
        // creatorTaxBps alone.
        IPonsMemeHook.LaunchInfo memory info = IPonsMemeHook(PONS_MEME_HOOK).launches(p.id);
        require(info.registered, "pool not registered with hook");
        assertEq(info.memecoinIsCurrency0, p.memecoinIsCurrency0, "hook disagrees on currency order");
        p.hookFeeBps = info.hookFeeBps;
        p.creatorTaxBps = info.creatorTaxBps;
    }

    /// Buying the memecoin spends the pair token. The swap direction follows from which
    /// side the memecoin sorted onto.
    function buyZeroForOne(PonsPool memory p) internal pure returns (bool) {
        return !p.memecoinIsCurrency0;
    }

    // ---------------------------------------------------------------------
    // Balances and funding
    // ---------------------------------------------------------------------

    function balanceOf(address currency, address who) internal view returns (uint256) {
        return currency == address(0) ? who.balance : IERC20Like(currency).balanceOf(who);
    }

    function fund(address currency, address who, uint256 amount) internal {
        if (currency == address(0)) {
            vm.deal(who, who.balance + amount);
        } else {
            deal(currency, who, IERC20Like(currency).balanceOf(who) + amount);
        }
    }

    function approveRouter(address currency, address owner) internal {
        if (currency == address(0)) return;
        vm.startPrank(owner);
        IERC20Like(currency).approve(PERMIT2, type(uint256).max);
        IPermit2Like(PERMIT2).approve(currency, UNIVERSAL_ROUTER, type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------
    // The real execution route: UniversalRouter → V4Router → PoolManager → PonsV2MemeHook
    // ---------------------------------------------------------------------

    function routerExactInSingle(PonsPool memory p, bool zeroForOne, uint128 amountIn, uint128 minOut, address from)
        internal
    {
        address inputCurrency = Currency.unwrap(zeroForOne ? p.key.currency0 : p.key.currency1);
        address outputCurrency = Currency.unwrap(zeroForOne ? p.key.currency1 : p.key.currency0);

        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            RouterExactInputSingleParams({
                poolKey: p.key,
                zeroForOne: zeroForOne,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(inputCurrency, uint256(amountIn));
        params[2] = abi.encode(outputCurrency, uint256(minOut));
        _execute(abi.encode(actions, params), inputCurrency == address(0) ? amountIn : 0, from);
    }

    function routerExactOutSingle(PonsPool memory p, bool zeroForOne, uint128 amountOut, uint128 maxIn, address from)
        internal
    {
        address inputCurrency = Currency.unwrap(zeroForOne ? p.key.currency0 : p.key.currency1);
        address outputCurrency = Currency.unwrap(zeroForOne ? p.key.currency1 : p.key.currency0);

        bytes memory actions = abi.encodePacked(ACT_SWAP_EXACT_OUT_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL);
        bytes[] memory params = new bytes[](3);
        params[0] = abi.encode(
            RouterExactOutputSingleParams({
                poolKey: p.key,
                zeroForOne: zeroForOne,
                amountOut: amountOut,
                amountInMaximum: maxIn,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = abi.encode(inputCurrency, uint256(maxIn));
        params[2] = abi.encode(outputCurrency, uint256(amountOut));
        _execute(abi.encode(actions, params), inputCurrency == address(0) ? maxIn : 0, from);
    }

    function _execute(bytes memory v4Input, uint256 value, address from) private {
        bytes memory commands = abi.encodePacked(CMD_V4_SWAP);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = v4Input;
        vm.prank(from);
        IUniversalRouterLike(UNIVERSAL_ROUTER).execute{value: value}(commands, inputs, block.timestamp + 60);
    }

    // ---------------------------------------------------------------------
    // Hook fee event
    // ---------------------------------------------------------------------

    bytes32 internal constant HOOK_FEE_COLLECTED = keccak256("HookFeeCollected(bytes32,address,uint256,uint256)");

    /// Returns the single HookFeeCollected emitted for `id` in the recorded logs.
    function hookFeeFromLogs(Vm.Log[] memory logs, PoolId id)
        internal
        pure
        returns (bool found, address currency, uint256 feeAmount, uint256 taxAmount)
    {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != PONS_MEME_HOOK || logs[i].topics.length < 2) continue;
            if (logs[i].topics[0] != HOOK_FEE_COLLECTED || logs[i].topics[1] != PoolId.unwrap(id)) continue;
            require(!found, "multiple HookFeeCollected for one swap");
            found = true;
            (currency, feeAmount, taxAmount) = abi.decode(logs[i].data, (address, uint256, uint256));
        }
    }
}

// -------------------------------------------------------------------------
// Interfaces. Shapes copied from the Blockscout-verified sources of the deployed
// contracts, not from the pinned periphery — the deployed UniversalRouter embeds a newer
// V4Router whose single-hop params carry `minHopPriceX36`.
// -------------------------------------------------------------------------

struct RouterExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}

struct RouterExactOutputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountOut;
    uint128 amountInMaximum;
    uint256 minHopPriceX36;
    bytes hookData;
}

interface IUniversalRouterLike {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2Like {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function transfer(address, uint256) external returns (bool);
}

/// PonsV2LaunchFactory (verified 2026-08-04, solc 0.8.35) — ILaunchpadV2.LaunchedToken.
interface IPonsFactory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken;
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase; // GraduationPhase: 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    function poolManager() external view returns (address);
    function memeHook() external view returns (address);
}

/// PonsV2MemeHook (verified 2026-08-03) — public `launches` getter.
interface IPonsMemeHook {
    struct LaunchInfo {
        bool registered;
        bool memecoinIsCurrency0;
        address memecoin;
        address quoteToken;
        address creator;
        address buybackCreatorRecipient;
        address protocolFeeRecipient;
        uint16 creatorTaxBps;
        uint16 protocolFeeShareBps;
        uint16 buybackBurnBps;
        uint16 hookFeeBps;
        uint16 maxInternalPriceImpactBps;
        bool buybackEnabled;
    }

    function launches(PoolId id) external view returns (LaunchInfo memory);
}

/// PonsV2BondingCurve (verified as part of the factory bundle).
interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
    function getReserves() external view returns (uint256 quoteReserve, uint256 tokenReserve);
    function feeBps() external view returns (uint256);
    function creatorTaxBps() external view returns (uint256);
    function sellableTokens() external view returns (uint256);
    function reservedTokens() external view returns (uint256);
    function currentSnipeTaxBps(address recipient) external view returns (uint256);
    function graduated() external view returns (bool);
    function readyToGraduate() external view returns (bool);
    function pairToken() external view returns (address);
    function token() external view returns (address);
    function trackedQuote() external view returns (uint256);
    function graduationThreshold() external view returns (uint256);
}
