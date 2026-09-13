// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {FeeTakingHook} from "@uniswap/v4-core/src/test/FeeTakingHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";

/**
 * Phase 7D.3 §6 — does V4Quoter's amountOut already account for a hook that takes its cut
 * in afterSwap via a returned delta?
 *
 * This is the question gating a mainnet V4Quoter deployment for Pons. Reading the core
 * contracts said yes (Hooks.sol: `swapDelta = swapDelta - hookDelta`). This test executes
 * it rather than reasoning about it: quote a sell, then perform the identical sell, and
 * compare the quote against what the swapper actually receives.
 *
 * The Pons MemeHook's permissions are AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA (decoded from
 * its address, 0x2044). v4-core's own FeeTakingHook has exactly that shape — it takes a
 * percentage of the swap output with `manager.take` and returns the amount as an int128
 * delta — so it is a faithful stand-in. Pons charges 200 bps; FeeTakingHook charges 123.
 * The percentage is irrelevant to the question; the mechanism is what matters.
 *
 * Runs entirely inside Foundry's EVM. No RPC, no fork, no key, no gas.
 */
contract QuoterHookDeltaTest is Test, Deployers {
    FeeTakingHook hook;
    V4Quoter quoter;
    PoolKey taxedKey;
    PoolKey untaxedKey;

    /// Hook permissions live in the low bits of the address, so the hook must be placed
    /// at an address carrying exactly the flags it implements.
    /// Exactly the Pons MemeHook's swap-side permissions (its address decodes to 0x2044).
    /// Deliberately NO liquidity flags: Pons has none, and granting them would invoke
    /// FeeTakingHook's liquidity fee paths, which is not the mechanism under test.
    uint160 constant TAX_HOOK_FLAGS = uint160(Hooks.AFTER_SWAP_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG);

    function setUp() public {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        quoter = new V4Quoter(manager);

        address hookAddr = address(TAX_HOOK_FLAGS ^ (0x4444 << 144));
        deployCodeTo("FeeTakingHook.sol:FeeTakingHook", abi.encode(manager), hookAddr);
        hook = FeeTakingHook(hookAddr);

        // Two pools: one with the tax hook, one with no hook at all. The untaxed pool is
        // the control — without it, a matching quote could just mean "the quoter and the
        // swap are consistently wrong in the same way".
        (taxedKey,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(hookAddr), 3000, SQRT_PRICE_1_1);
        (untaxedKey,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
    }

    /// Execute an exact-input sell of currency0 and return what the swapper actually got.
    function _executeSwap(PoolKey memory key, uint128 amountIn) internal returns (uint256 received) {
        BalanceDelta delta = swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: MIN_PRICE_LIMIT
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        // Positive amount1 is what the swapper receives.
        received = uint256(uint128(delta.amount1()));
    }

    function _quote(PoolKey memory key, uint128 amountIn) internal returns (uint256 amountOut) {
        (amountOut,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: key,
                zeroForOne: true,
                exactAmount: amountIn,
                hookData: ""
            })
        );
    }

    /// The control: with no hook, quote and execution must agree exactly.
    function test_quoteMatchesExecution_withoutHook() public {
        uint128 amountIn = 1e15;
        uint256 quoted = _quote(untaxedKey, amountIn);
        uint256 received = _executeSwap(untaxedKey, amountIn);

        assertGt(quoted, 0, "control quote should be non-zero");
        assertEq(quoted, received, "no-hook quote must equal realized output");
    }

    /// The question that gates deployment.
    function test_quoteMatchesExecution_withAfterSwapTaxHook() public {
        uint128 amountIn = 1e15;
        uint256 quoted = _quote(taxedKey, amountIn);
        uint256 received = _executeSwap(taxedKey, amountIn);

        console2.log("quoted   :", quoted);
        console2.log("received :", received);
        assertGt(quoted, 0, "taxed quote should be non-zero");
        // If the quoter reported raw pool output, this would be ~1.23% high.
        assertEq(quoted, received, "quote must be NET of the hook's afterSwap delta");
    }

    /// Proves the hook is actually taking a cut — otherwise the test above proves nothing.
    function test_hookActuallyReducesOutput() public {
        uint128 amountIn = 1e15;
        uint256 untaxed = _quote(untaxedKey, amountIn);
        uint256 taxed = _quote(taxedKey, amountIn);

        console2.log("untaxed quote :", untaxed);
        console2.log("taxed quote   :", taxed);
        console2.log("shortfall     :", untaxed - taxed);
        assertLt(taxed, untaxed, "taxed pool must quote less than the untaxed control");

        // The shortfall should match FeeTakingHook's 123 bips of the output, within the
        // rounding the hook's integer division introduces.
        uint256 expectedFee = untaxed * hook.SWAP_FEE_BIPS() / hook.TOTAL_BIPS();
        assertApproxEqAbs(untaxed - taxed, expectedFee, 2, "shortfall should equal the hook fee");
    }

    /// The same relationship must hold across sizes, not just one lucky amount.
    function test_quoteMatchesExecutionAcrossSizes() public {
        uint128[4] memory sizes = [uint128(1e12), uint128(1e14), uint128(1e15), uint128(5e15)];
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            uint256 quoted = _quote(taxedKey, sizes[i]);
            uint256 received = _executeSwap(taxedKey, sizes[i]);
            assertEq(quoted, received, "quote must equal execution at every size");
            vm.revertToState(snap);
        }
    }
}
