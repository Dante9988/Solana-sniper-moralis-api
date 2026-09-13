// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {PonsForkBase, IERC20Like, IPonsCurve, IPonsFactory} from "./PonsForkBase.sol";

/**
 * Phase 7D.3.2 §4 — pre-graduation quotes against the REAL PonsV2BondingCurve contracts.
 *
 * The backend prices curve trades off-chain from view state read at one block. That is
 * only honest if the formula reproduces the contract to the wei. This suite applies the
 * formula as documented in the verified source (PonsV2BondingCurve.buy/sell and
 * PonsV2BondingCurveMath) to the pinned state, executes the real trade on the fork, and
 * requires exact equality. It also records the inputs so the TypeScript adapter is tested
 * against the same numbers (src/pons/__fixtures__/curveQuoteFork.json).
 *
 * Snipe tax is NOT modelled. It only applies within `snipeTaxSeconds` (3 s at FORK_BLOCK)
 * of launch, and the backend refuses to quote inside that window instead.
 */
contract PonsCurveForkTest is PonsForkBase {
    uint256 internal constant BPS = 10_000;

    struct CurveCase {
        string label;
        address token;
    }

    CurveCase[] internal cases;
    /// Appended line by line — see PonsV4QuoteForkTest.evidenceFile.
    string internal evidenceFile;

    function setUp() public override {
        super.setUp();
        // The most-funded live curves at FORK_BLOCK in each class.
        cases.push(CurveCase("native ETH curve, creator tax 200", 0x583b10D1912e8D3dEF8709a6C1Cb7aC88fa27fd7));
        cases.push(CurveCase("native ETH curve, creator tax 100", 0xEfC1D3E4A1Fd41cCe8B090D9533b0Df853cd8A2F));
        cases.push(CurveCase("USDG (6 dp) curve, creator tax 199", 0x9179B7b6943fD727Fb5c72e079bC150D74eB356C));
    }

    // ---------------------------------------------------------------------
    // The documented formula (mirrors src/pons/curveQuote.ts)
    // ---------------------------------------------------------------------

    function _amountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        // PonsV2BondingCurveMath._amountOut with feeBps = 0: fees are removed before pricing.
        uint256 inWithFee = amountIn * BPS;
        return (inWithFee * reserveOut) / (reserveIn * BPS + inWithFee);
    }

    function _amountIn(uint256 amountOut, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        return (amountOut * reserveIn * BPS) / ((reserveOut - amountOut) * BPS) + 1;
    }

    struct BuyQuote {
        uint256 tokensOut;
        uint256 spent;
        uint256 refund;
        uint256 fee;
        uint256 tax;
        bool clamped;
    }

    function _quoteBuy(IPonsCurve c, uint256 quoteIn) internal view returns (BuyQuote memory q) {
        (uint256 qr, uint256 tr) = c.getReserves();
        uint256 feeBps = c.feeBps();
        uint256 taxBps = c.creatorTaxBps();
        q.spent = quoteIn;
        q.fee = (quoteIn * feeBps) / BPS;
        q.tax = (quoteIn * taxBps) / BPS;
        q.tokensOut = _amountOut(quoteIn - q.fee - q.tax, qr, tr);
        uint256 sellable = c.sellableTokens();
        if (q.tokensOut > sellable) {
            q.clamped = true;
            q.tokensOut = sellable;
            uint256 net = _amountIn(sellable, qr, tr);
            uint256 grossed = _mulDivUp(net, BPS, BPS - feeBps - taxBps);
            q.spent = grossed < quoteIn ? grossed : quoteIn;
            q.fee = (q.spent * feeBps) / BPS;
            q.tax = (q.spent * taxBps) / BPS;
        }
        q.refund = quoteIn - q.spent;
    }

    function _quoteSell(IPonsCurve c, uint256 tokensIn) internal view returns (uint256 quoteOut, uint256 fee, uint256 tax) {
        (uint256 qr, uint256 tr) = c.getReserves();
        uint256 gross = _amountOut(tokensIn, tr, qr);
        fee = (gross * c.feeBps()) / BPS;
        tax = (gross * c.creatorTaxBps()) / BPS;
        quoteOut = gross - fee - tax;
    }

    function _mulDivUp(uint256 a, uint256 b, uint256 d) internal pure returns (uint256) {
        return (a * b + d - 1) / d;
    }

    // ---------------------------------------------------------------------
    // Tests
    // ---------------------------------------------------------------------

    function test_curveBuyAndSellQuotesMatchExecution() public {
        evidenceFile = string.concat(EVIDENCE_DIR, "curve-quotes.jsonl");
        vm.writeFile(evidenceFile, "");
        for (uint256 i = 0; i < cases.length; i++) {
            IPonsFactory.LaunchedToken memory lt = IPonsFactory(PONS_V2_FACTORY).getLaunchedToken(cases[i].token);
            assertEq(lt.phase, 0, "case is not on its curve");
            IPonsCurve c = IPonsCurve(lt.curve);
            assertEq(c.currentSnipeTaxBps(trader), 0, "snipe window still open at pinned block");

            uint256[3] memory sizes = _sizes(lt.pairToken);
            for (uint256 s = 0; s < sizes.length; s++) {
                uint256 snap = vm.snapshotState();
                _checkBuy(cases[i].label, lt, c, sizes[s]);
                vm.revertToState(snap);
            }

            uint256 snapSell = vm.snapshotState();
            uint256 held = _buy(lt, c, sizes[1]);
            uint256[3] memory fractions = [uint256(1_000), 5_000, 10_000];
            for (uint256 s = 0; s < fractions.length; s++) {
                uint256 snap = vm.snapshotState();
                _checkSell(cases[i].label, lt, c, (held * fractions[s]) / BPS);
                vm.revertToState(snap);
            }
            vm.revertToState(snapSell);
        }
    }

    /// A buy larger than the remaining allocation is filled only up to it and refunded the
    /// rest. A quote that ignored this would overstate both spend and output.
    function test_oversizedBuyIsClampedAndRefunded() public {
        IPonsFactory.LaunchedToken memory lt = IPonsFactory(PONS_V2_FACTORY).getLaunchedToken(cases[0].token);
        IPonsCurve c = IPonsCurve(lt.curve);
        uint256 remaining = lt.graduationThreshold - c.trackedQuote();
        uint256 offered = remaining * 3;

        BuyQuote memory q = _quoteBuy(c, offered);
        assertTrue(q.clamped, "expected a clamped fill");

        evidenceFile = string.concat(EVIDENCE_DIR, "curve-clamp.jsonl");
        vm.writeFile(evidenceFile, "");
        _checkBuy("clamped buy, native ETH curve", lt, c, offered);

        // Once the allocation is gone the curve refuses sells, even if graduation itself did
        // not complete in the same transaction.
        IPonsFactory.LaunchedToken memory after_ = IPonsFactory(PONS_V2_FACTORY).getLaunchedToken(cases[0].token);
        if (after_.phase == 0 && !c.graduated()) {
            assertTrue(c.readyToGraduate(), "allocation not exhausted");
            vm.startPrank(trader);
            IERC20Like(lt.token).approve(address(c), type(uint256).max);
            vm.expectRevert();
            c.sell(1e18, 0, trader);
            vm.stopPrank();
        }
    }

    function test_sellBelowMinimumReverts() public {
        IPonsFactory.LaunchedToken memory lt = IPonsFactory(PONS_V2_FACTORY).getLaunchedToken(cases[0].token);
        IPonsCurve c = IPonsCurve(lt.curve);
        uint256 held = _buy(lt, c, 0.01 ether);
        (uint256 quoted,,) = _quoteSell(c, held);
        vm.startPrank(trader);
        IERC20Like(lt.token).approve(address(c), held);
        vm.expectRevert();
        c.sell(held, quoted + 1, trader);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------

    function _checkBuy(string memory label, IPonsFactory.LaunchedToken memory lt, IPonsCurve c, uint256 quoteIn) internal {
        (uint256 qr, uint256 tr) = c.getReserves();
        uint256 sellableBefore = c.sellableTokens();
        BuyQuote memory q = _quoteBuy(c, quoteIn);

        fund(lt.pairToken, trader, quoteIn);
        if (lt.pairToken != address(0)) {
            vm.prank(trader);
            IERC20Like(lt.pairToken).approve(address(c), quoteIn);
        }
        uint256 quoteBefore = balanceOf(lt.pairToken, trader);
        uint256 tokenBefore = IERC20Like(lt.token).balanceOf(trader);

        vm.prank(trader);
        uint256 returned = c.buy{value: lt.pairToken == address(0) ? quoteIn : 0}(quoteIn, q.tokensOut, trader);

        uint256 got = IERC20Like(lt.token).balanceOf(trader) - tokenBefore;
        uint256 paid = quoteBefore - balanceOf(lt.pairToken, trader);
        assertEq(returned, q.tokensOut, string.concat(label, ": returned != quoted"));
        assertEq(got, q.tokensOut, string.concat(label, ": received != quoted"));
        assertEq(paid, q.spent, string.concat(label, ": paid != quoted spend"));
        _row(label, "buy", lt, c, quoteIn, qr, tr, sellableBefore, q.tokensOut, got, q.spent, paid, q.fee, q.tax, q.clamped);
    }

    function _checkSell(string memory label, IPonsFactory.LaunchedToken memory lt, IPonsCurve c, uint256 tokensIn) internal {
        (uint256 qr, uint256 tr) = c.getReserves();
        uint256 sellableBefore = c.sellableTokens();
        (uint256 quoteOut, uint256 fee, uint256 tax) = _quoteSell(c, tokensIn);
        uint256 quoteBefore = balanceOf(lt.pairToken, trader);

        vm.startPrank(trader);
        IERC20Like(lt.token).approve(address(c), tokensIn);
        uint256 returned = c.sell(tokensIn, quoteOut, trader);
        vm.stopPrank();

        uint256 got = balanceOf(lt.pairToken, trader) - quoteBefore;
        assertEq(returned, quoteOut, string.concat(label, ": sell returned != quoted"));
        assertEq(got, quoteOut, string.concat(label, ": sell received != quoted"));
        _row(label, "sell", lt, c, tokensIn, qr, tr, sellableBefore, quoteOut, got, tokensIn, tokensIn, fee, tax, false);
    }

    function _buy(IPonsFactory.LaunchedToken memory lt, IPonsCurve c, uint256 quoteIn) internal returns (uint256 held) {
        fund(lt.pairToken, trader, quoteIn);
        vm.startPrank(trader);
        if (lt.pairToken != address(0)) IERC20Like(lt.pairToken).approve(address(c), quoteIn);
        held = c.buy{value: lt.pairToken == address(0) ? quoteIn : 0}(quoteIn, 0, trader);
        vm.stopPrank();
    }

    function _sizes(address pairToken) internal view returns (uint256[3] memory) {
        if (pairToken == address(0)) return [uint256(0.001 ether), 0.01 ether, 0.1 ether];
        uint256 unit = 10 ** IERC20Like(pairToken).decimals();
        return [unit, unit * 10, unit * 100];
    }

    function _row(
        string memory label,
        string memory side,
        IPonsFactory.LaunchedToken memory lt,
        IPonsCurve c,
        uint256 amountIn,
        uint256 quoteReserve,
        uint256 tokenReserve,
        uint256 sellable,
        uint256 quotedOut,
        uint256 observedOut,
        uint256 quotedSpend,
        uint256 observedSpend,
        uint256 fee,
        uint256 tax,
        bool clamped
    ) internal {
        string memory a = string.concat(
            '{"source":"actual-pons-fork","block":', vm.toString(FORK_BLOCK), ',"case":"', label,
            '","token":"', vm.toString(lt.token), '","curve":"', vm.toString(address(c)), '","pairToken":"', vm.toString(lt.pairToken),
            '","side":"', side, '","feeBps":', vm.toString(c.feeBps()), ',"creatorTaxBps":', vm.toString(c.creatorTaxBps())
        );
        string memory b = string.concat(
            ',"amountIn":"', vm.toString(amountIn), '","quoteReserve":"', vm.toString(quoteReserve),
            '","tokenReserve":"', vm.toString(tokenReserve), '","sellableTokens":"', vm.toString(sellable),
            '","quotedOut":"', vm.toString(quotedOut), '","observedOut":"', vm.toString(observedOut)
        );
        string memory d = string.concat(
            '","quotedSpend":"', vm.toString(quotedSpend), '","observedSpend":"', vm.toString(observedSpend),
            '","fee":"', vm.toString(fee), '","creatorTax":"', vm.toString(tax), '","clamped":', clamped ? "true" : "false", "}"
        );
        vm.writeLine(evidenceFile, string.concat(a, b, d));
    }
}
