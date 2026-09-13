// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {V4Quoter} from "v4-periphery/src/lens/V4Quoter.sol";
import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import {PonsForkBase, IERC20Like} from "./PonsForkBase.sol";

/**
 * Phase 7D.3.2 §2 — do V4 quotes for graduated Pons pools match what a wallet actually
 * receives through the real execution route?
 *
 * For every representative pool, direction and size this:
 *   1. quotes with the OFFICIAL quoter and with a quoter built from pinned source,
 *   2. executes the identical swap through the deployed UniversalRouter,
 *   3. compares the quote with the recipient's measured balance change, and
 *   4. reconciles the hook's HookFeeCollected event against the fee terms the hook itself
 *      recorded for that pool.
 *
 * Each size runs from the same pinned state (snapshot/revert), so sizes do not move each
 * other's price.
 */
contract PonsV4QuoteForkTest is PonsForkBase {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant BPS = 10_000;

    struct Case {
        string label;
        address token;
    }

    V4Quoter internal pinnedQuoter;
    Case[] internal cases;

    /// Evidence is appended line by line. vm.revertToState also reverts this contract's
    /// storage, so rows accumulated in a string would be silently discarded.
    string internal evidenceFile;

    function setUp() public override {
        super.setUp();
        pinnedQuoter = new V4Quoter(IPoolManager(POOL_MANAGER));

        // Chosen at FORK_BLOCK from all 164 graduated pools (see
        // docs/phase-7d3-2-quote-verification.md §3): the deepest pool in each class.
        cases.push(Case("native ETH, memecoin currency1, creator tax 200", 0x3BD9136D51Af679Bd1B11D06B951155543C5449f));
        cases.push(Case("native ETH, creator tax 0", 0x2d3cB608Eae441f80766aB2eAf065f2ed20a769F));
        cases.push(Case("native ETH, creator tax 500", 0xa9BB7C650C62Da3CFBcDd0eA843953817495d1A4));
        cases.push(Case("USDG (6 dp), memecoin currency0", 0x33a242a71604a0744EC1d602a1967091AE970454));
        cases.push(Case("USDG (6 dp), memecoin currency1", 0xdE127623285d13c19e01B9E430d836C6b12B1ba1));
        cases.push(Case("18 dp ERC-20 pair, memecoin currency0", 0x91fB2c77E751fdA51C0e370C513ba2A5da37C092));
        cases.push(Case("cbBTC (8 dp), memecoin currency0", 0x3B772d950be7a9419C355c84E6251b48079c5046));
    }

    // ---------------------------------------------------------------------
    // 1. Identity of the official quoter
    // ---------------------------------------------------------------------

    /// The official deployment is exactly v4-periphery commit 6601a199 compiled with Uniswap's
    /// release settings. Immutables are identical too, because both are bound to the same
    /// PoolManager.
    function test_officialQuoterIsPinnedSource() public view {
        assertEq(OFFICIAL_QUOTER.code.length, 6118, "unexpected official quoter size");
        assertEq(keccak256(address(pinnedQuoter).code), keccak256(OFFICIAL_QUOTER.code), "runtime bytecode differs");
    }

    // ---------------------------------------------------------------------
    // 2. Exact-input buys and sells, several sizes, every pool class
    // ---------------------------------------------------------------------

    function test_exactInputQuotesMatchRouterExecution() public {
        evidenceFile = string.concat(EVIDENCE_DIR, "v4-exact-input.jsonl");
        vm.writeFile(evidenceFile, "");
        for (uint256 i = 0; i < cases.length; i++) {
            PonsPool memory p = loadPool(cases[i].token);
            assertEq(p.phase, 2, "case is not a graduated pool");

            uint256[] memory buySizes = _sizesForPair(p);
            for (uint256 s = 0; s < buySizes.length; s++) {
                uint256 snap = vm.snapshotState();
                _checkExactIn(cases[i].label, p, true, uint128(buySizes[s]));
                vm.revertToState(snap);
            }

            // Sells need inventory, acquired the honest way: a real buy through the router.
            uint256 snapSell = vm.snapshotState();
            uint256 held = _acquireTokens(p, uint128(buySizes[1]));
            uint256[3] memory sellFractions = [uint256(1_000), 5_000, 10_000];
            for (uint256 s = 0; s < sellFractions.length; s++) {
                uint256 snap = vm.snapshotState();
                _checkExactIn(cases[i].label, p, false, uint128((held * sellFractions[s]) / BPS));
                vm.revertToState(snap);
            }
            vm.revertToState(snapSell);
        }
    }

    function _checkExactIn(string memory label, PonsPool memory p, bool isBuy, uint128 amountIn) internal {
        bool zeroForOne = isBuy ? buyZeroForOne(p) : !buyZeroForOne(p);
        address inputCurrency = _unwrap(zeroForOne ? p.key.currency0 : p.key.currency1);
        address outputCurrency = _unwrap(zeroForOne ? p.key.currency1 : p.key.currency0);

        IV4Quoter.QuoteExactSingleParams memory qp =
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: amountIn, hookData: ""});
        (uint256 officialOut, uint256 gasEstimate) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(qp);
        (uint256 pinnedOut,) = pinnedQuoter.quoteExactInputSingle(qp);
        assertEq(pinnedOut, officialOut, "pinned and official quoters disagree");

        if (isBuy) fund(inputCurrency, trader, amountIn);
        approveRouter(inputCurrency, trader);

        (uint160 sqrtBefore,,,) = IPoolManager(POOL_MANAGER).getSlot0(p.id);
        uint256 inBefore = balanceOf(inputCurrency, trader);
        uint256 outBefore = balanceOf(outputCurrency, trader);

        vm.recordLogs();
        routerExactInSingle(p, zeroForOne, amountIn, uint128(officialOut), trader);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 received = balanceOf(outputCurrency, trader) - outBefore;
        uint256 spent = inBefore - balanceOf(inputCurrency, trader);
        assertEq(received, officialOut, string.concat(label, ": quote != received"));
        assertEq(spent, amountIn, string.concat(label, ": input not fully spent"));

        // The fee is charged on the unspecified (output) leg of an exact-input swap. Gross
        // output is what the pool paid before the hook's take; the hook's recorded bps must
        // explain the difference exactly.
        (bool found, address feeCurrency, uint256 feeAmount, uint256 taxAmount) = hookFeeFromLogs(logs, p.id);
        uint256 totalBps = uint256(p.hookFeeBps) + p.creatorTaxBps;
        if (totalBps == 0) {
            assertFalse(found, "fee event on a zero-fee pool");
        } else {
            assertTrue(found, "no HookFeeCollected");
            assertEq(feeCurrency, outputCurrency, "fee not charged on the output leg");
            uint256 gross = received + feeAmount + taxAmount;
            assertEq(feeAmount, (gross * p.hookFeeBps) / BPS, "hook fee != launches().hookFeeBps");
            assertEq(taxAmount, (gross * p.creatorTaxBps) / BPS, "creator tax != launches().creatorTaxBps");
        }

        (uint160 sqrtAfter,,,) = IPoolManager(POOL_MANAGER).getSlot0(p.id);
        _row(label, isBuy ? "buy" : "sell", "exactIn", p, amountIn, officialOut, received, feeAmount, taxAmount, gasEstimate, sqrtBefore, sqrtAfter);
    }

    // ---------------------------------------------------------------------
    // 3. Minimum output: a quote is a boundary, not a promise
    // ---------------------------------------------------------------------

    function test_minimumOutputAboveQuoteReverts() public {
        PonsPool memory p = loadPool(cases[0].token);
        uint128 amountIn = uint128(_sizesForPair(p)[1]);
        bool zeroForOne = buyZeroForOne(p);
        (uint256 quoted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: amountIn, hookData: ""})
        );
        fund(_unwrap(p.key.currency0), trader, amountIn);

        uint256 snap = vm.snapshotState();
        vm.expectRevert(abi.encodeWithSelector(V4TooLittleReceived.selector, quoted + 1, quoted));
        routerExactInSingle(p, zeroForOne, amountIn, uint128(quoted + 1), trader);
        vm.revertToState(snap);

        // Exactly the quote succeeds — the boundary is tight, not padded.
        routerExactInSingle(p, zeroForOne, amountIn, uint128(quoted), trader);
    }

    /// The quote is valid for one state. Someone else's trade in between moves it, and the
    /// same minimum then reverts. This is why quotes carry a block and an expiry.
    function test_quoteGoesStaleAfterAnotherTrade() public {
        PonsPool memory p = loadPool(cases[0].token);
        uint128 amountIn = uint128(_sizesForPair(p)[1]);
        bool zeroForOne = buyZeroForOne(p);
        IV4Quoter.QuoteExactSingleParams memory qp =
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: amountIn, hookData: ""});
        (uint256 quoted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(qp);

        address other = makeAddr("front-runner");
        fund(address(0), other, amountIn * 5);
        routerExactInSingle(p, zeroForOne, amountIn * 5, 0, other);

        (uint256 requoted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(qp);
        assertLt(requoted, quoted, "price did not move");

        fund(address(0), trader, amountIn);
        vm.expectRevert(abi.encodeWithSelector(V4TooLittleReceived.selector, quoted, requoted));
        routerExactInSingle(p, zeroForOne, amountIn, uint128(quoted), trader);
    }

    // ---------------------------------------------------------------------
    // 4. Exact output — the fee moves to the INPUT leg
    // ---------------------------------------------------------------------

    function test_exactOutputQuotesMatchRouterExecution() public {
        evidenceFile = string.concat(EVIDENCE_DIR, "v4-exact-output.jsonl");
        vm.writeFile(evidenceFile, "");
        for (uint256 i = 0; i < cases.length; i++) {
            PonsPool memory p = loadPool(cases[i].token);
            bool zeroForOne = buyZeroForOne(p);
            address inputCurrency = _unwrap(zeroForOne ? p.key.currency0 : p.key.currency1);
            address outputCurrency = p.token;

            // Target the output of a medium exact-input buy, so the size is sane per pool.
            (uint256 tokensWanted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(
                IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: uint128(_sizesForPair(p)[1]), hookData: ""})
            );
            IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
                poolKey: p.key,
                zeroForOne: zeroForOne,
                exactAmount: uint128(tokensWanted),
                hookData: ""
            });
            (uint256 officialIn, uint256 gasEstimate) = IV4Quoter(OFFICIAL_QUOTER).quoteExactOutputSingle(qp);
            (uint256 pinnedIn,) = pinnedQuoter.quoteExactOutputSingle(qp);
            assertEq(pinnedIn, officialIn, "pinned and official exact-output quotes disagree");

            uint256 snap = vm.snapshotState();
            fund(inputCurrency, trader, officialIn);
            approveRouter(inputCurrency, trader);
            uint256 inBefore = balanceOf(inputCurrency, trader);
            uint256 outBefore = balanceOf(outputCurrency, trader);
            (uint160 sqrtBefore,,,) = IPoolManager(POOL_MANAGER).getSlot0(p.id);

            vm.recordLogs();
            routerExactOutSingle(p, zeroForOne, uint128(tokensWanted), uint128(officialIn), trader);
            Vm.Log[] memory logs = vm.getRecordedLogs();

            uint256 spent = inBefore - balanceOf(inputCurrency, trader);
            uint256 received = balanceOf(outputCurrency, trader) - outBefore;
            assertEq(received, tokensWanted, "exact output not delivered");
            assertEq(spent, officialIn, "exact-output quote != spent");

            (bool found, address feeCurrency, uint256 feeAmount, uint256 taxAmount) = hookFeeFromLogs(logs, p.id);
            if (uint256(p.hookFeeBps) + p.creatorTaxBps != 0) {
                assertTrue(found, "no HookFeeCollected");
                assertEq(feeCurrency, inputCurrency, "exact-output fee not on the input leg");
                // Here the fee is a percentage of the pool's own input, i.e. of spent MINUS the take.
                uint256 poolInput = spent - feeAmount - taxAmount;
                assertEq(feeAmount, (poolInput * p.hookFeeBps) / BPS, "exact-out hook fee mismatch");
                assertEq(taxAmount, (poolInput * p.creatorTaxBps) / BPS, "exact-out creator tax mismatch");
            }
            (uint160 sqrtAfter,,,) = IPoolManager(POOL_MANAGER).getSlot0(p.id);
            _row(cases[i].label, "buy", "exactOut", p, officialIn, tokensWanted, received, feeAmount, taxAmount, gasEstimate, sqrtBefore, sqrtAfter);
            vm.revertToState(snap);
        }
    }

    // ---------------------------------------------------------------------
    // 5. Failure modes a quote endpoint must surface, not paper over
    // ---------------------------------------------------------------------

    /// Asking for more output than the pool can deliver is refused by the quoter itself.
    function test_insufficientLiquidityRevertsExactOutputQuote() public {
        PonsPool memory p = loadPool(cases[0].token);
        uint256 poolManagerHolds = IERC20Like(p.token).balanceOf(POOL_MANAGER);
        IV4Quoter.QuoteExactSingleParams memory qp = IV4Quoter.QuoteExactSingleParams({
            poolKey: p.key,
            zeroForOne: buyZeroForOne(p),
            exactAmount: uint128(poolManagerHolds + 1),
            hookData: ""
        });
        try IV4Quoter(OFFICIAL_QUOTER).quoteExactOutputSingle(qp) returns (uint256, uint256) {
            revert("exact-output quote beyond pool inventory succeeded");
        } catch (bytes memory reason) {
            vm.writeFile(
                string.concat(EVIDENCE_DIR, "v4-insufficient-liquidity.json"),
                string.concat('{"requestedOut":"', vm.toString(poolManagerHolds + 1), '","revert":"', vm.toString(reason), '"}')
            );
        }
    }

    /// Records what a very large exact-input quote does, rather than assuming.
    function test_oversizedExactInputIsRecorded() public {
        PonsPool memory p = loadPool(cases[0].token);
        bool zeroForOne = buyZeroForOne(p);
        uint128 huge = uint128(1_000_000 ether);
        IV4Quoter.QuoteExactSingleParams memory qp =
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: huge, hookData: ""});
        try IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(qp) returns (uint256 out, uint256) {
            // A quote succeeded; execution must still be checked, because a partially
            // filled exact-input swap would spend less than requested.
            fund(address(0), trader, huge);
            uint256 before = trader.balance;
            try this.externalExactIn(p, zeroForOne, huge, uint128(out)) {
                vm.writeFile(
                    string.concat(EVIDENCE_DIR, "v4-oversized-input.json"),
                    string.concat('{"quoteSucceeded":true,"executionSucceeded":true,"requested":"', vm.toString(uint256(huge)),
                        '","spent":"', vm.toString(before - trader.balance), '","quotedOut":"', vm.toString(out), '"}')
                );
            } catch (bytes memory reason) {
                vm.writeFile(
                    string.concat(EVIDENCE_DIR, "v4-oversized-input.json"),
                    string.concat('{"quoteSucceeded":true,"executionSucceeded":false,"revert":"', vm.toString(reason), '"}')
                );
            }
        } catch (bytes memory reason) {
            vm.writeFile(
                string.concat(EVIDENCE_DIR, "v4-oversized-input.json"),
                string.concat('{"quoteSucceeded":false,"revert":"', vm.toString(reason), '"}')
            );
        }
    }

    function externalExactIn(PonsPool memory p, bool zeroForOne, uint128 amountIn, uint128 minOut) external {
        routerExactInSingle(p, zeroForOne, amountIn, minOut, trader);
    }

    /// A pool key that does not exist (wrong tick spacing) cannot be quoted.
    function test_uninitializedPoolQuoteReverts() public {
        PonsPool memory p = loadPool(cases[0].token);
        p.key.tickSpacing = 60;
        vm.expectRevert();
        IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: true, exactAmount: 1e15, hookData: ""})
        );
    }

    /// The quoter simulates the pool, not the wallet. A holder who has not approved Permit2
    /// gets a perfectly good sell quote and a reverting sell. So a successful quote must
    /// never be presented as "you can sell".
    function test_successfulSellQuoteDoesNotImplyWalletCanSell() public {
        PonsPool memory p = loadPool(cases[0].token);
        uint256 held = _acquireTokens(p, uint128(_sizesForPair(p)[1]));
        bool zeroForOne = !buyZeroForOne(p);

        (uint256 quoted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: uint128(held), hookData: ""})
        );
        assertGt(quoted, 0);

        address holder = makeAddr("unapproved-holder");
        vm.prank(trader);
        IERC20Like(p.token).transfer(holder, held);

        try this.externalExactInFrom(p, zeroForOne, uint128(held), holder) {
            revert("unapproved holder sold through the router");
        } catch (bytes memory reason) {
            vm.writeFile(
                string.concat(EVIDENCE_DIR, "v4-quote-ok-sell-reverts.json"),
                string.concat('{"quotedOut":"', vm.toString(quoted), '","sellRevert":"', vm.toString(reason), '"}')
            );
        }
    }

    function externalExactInFrom(PonsPool memory p, bool zeroForOne, uint128 amountIn, address from) external {
        routerExactInSingle(p, zeroForOne, amountIn, 0, from);
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    /// Three sizes in the pair asset's own decimals: small, medium, large.
    function _sizesForPair(PonsPool memory p) internal view returns (uint256[] memory sizes) {
        sizes = new uint256[](3);
        if (p.pairToken == address(0)) {
            sizes[0] = 0.001 ether;
            sizes[1] = 0.01 ether;
            sizes[2] = 0.1 ether;
            return sizes;
        }
        uint8 dec = IERC20Like(p.pairToken).decimals();
        // One unit of an 18-dp stock token or USDG is a sensible small trade; cbBTC is far
        // more valuable per unit, so it starts at 1e-5 BTC.
        uint256 unit = 10 ** dec;
        uint256 base = dec == 8 ? unit / 100_000 : unit;
        sizes[0] = base;
        sizes[1] = base * 10;
        sizes[2] = base * 100;
    }

    function _acquireTokens(PonsPool memory p, uint128 spend) internal returns (uint256 held) {
        address inputCurrency = p.pairToken;
        fund(inputCurrency, trader, spend);
        approveRouter(inputCurrency, trader);
        uint256 before = IERC20Like(p.token).balanceOf(trader);
        routerExactInSingle(p, buyZeroForOne(p), spend, 0, trader);
        held = IERC20Like(p.token).balanceOf(trader) - before;
        approveRouter(p.token, trader);
    }

    function _unwrap(Currency_ c) internal pure returns (address) {
        return Currency_.unwrap(c);
    }

    function _row(
        string memory label,
        string memory side,
        string memory kind,
        PonsPool memory p,
        uint256 amountSpecified,
        uint256 quoted,
        uint256 observed,
        uint256 feeAmount,
        uint256 taxAmount,
        uint256 gasEstimate,
        uint160 sqrtBefore,
        uint160 sqrtAfter
    ) internal {
        string memory line = string.concat(
            '{"source":"actual-pons-fork","block":', vm.toString(FORK_BLOCK),
            ',"case":"', label, '","token":"', vm.toString(p.token), '","pairToken":"', vm.toString(p.pairToken),
            '","poolId":"', vm.toString(PoolId_.unwrap(p.id)), '","memecoinIsCurrency0":', p.memecoinIsCurrency0 ? "true" : "false",
            ',"hookFeeBps":', vm.toString(uint256(p.hookFeeBps)), ',"creatorTaxBps":', vm.toString(uint256(p.creatorTaxBps))
        );
        line = string.concat(
            line,
            ',"side":"', side, '","kind":"', kind, '","amountSpecified":"', vm.toString(amountSpecified),
            '","quoted":"', vm.toString(quoted), '","observed":"', vm.toString(observed),
            '","hookFee":"', vm.toString(feeAmount), '","creatorTax":"', vm.toString(taxAmount),
            '","quoterGasEstimate":"', vm.toString(gasEstimate), '","sqrtPriceBefore":"', vm.toString(uint256(sqrtBefore)),
            '","sqrtPriceAfter":"', vm.toString(uint256(sqrtAfter)), '"}'
        );
        vm.writeLine(evidenceFile, line);
    }
}

import {Currency as Currency_} from "@uniswap/v4-core/src/types/Currency.sol";
import {PoolId as PoolId_} from "@uniswap/v4-core/src/types/PoolId.sol";

/// From the deployed router's verified IV4Router.
error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived);
