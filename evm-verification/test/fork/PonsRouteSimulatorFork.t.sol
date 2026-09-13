// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IV4Quoter} from "v4-periphery/src/interfaces/IV4Quoter.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";

import {PonsForkBase, IERC20Like, IPonsCurve, IPonsFactory, RouterExactInputSingleParams} from "./PonsForkBase.sol";
import {PonsRouteSimulator} from "../../src/PonsRouteSimulator.sol";

/**
 * Phase 7D.3.2 §5 — the backend's execution simulation, exercised exactly as the backend
 * runs it: simulator runtime code placed at a synthetic address (vm.etch here, an
 * eth_call state override in production), funded by overriding its balance, then driving
 * the real route at the pinned block.
 *
 * The runtime bytecode exported to the backend is taken from this profile's compilation
 * (out-fork), so what is tested here is byte-for-byte what production sends.
 */
contract PonsRouteSimulatorForkTest is PonsForkBase {
    address internal constant SIM = 0x0000000000000000000000000000000051350001;
    uint256 internal constant BPS = 10_000;

    function setUp() public override {
        super.setUp();
        vm.etch(SIM, type(PonsRouteSimulator).runtimeCode);
    }

    function test_routerBuySimulationEqualsQuote() public {
        PonsPool memory p = loadPool(0x3BD9136D51Af679Bd1B11D06B951155543C5449f);
        uint128 amountIn = 0.01 ether;
        bool zeroForOne = buyZeroForOne(p);
        (uint256 quoted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: amountIn, hookData: ""})
        );
        vm.deal(SIM, amountIn);

        PonsRouteSimulator.Result memory r = _simulateRouter(p, zeroForOne, amountIn, uint128(quoted));
        assertTrue(r.success, "simulation reverted");
        assertEq(r.inputBalanceBefore, amountIn, "override balance not observed");
        assertEq(r.received, quoted, "simulated output != quote");
        assertEq(r.spent, amountIn, "simulated spend != input");
        assertGt(r.gasUsed, 0);
    }

    function test_routerSellSimulationWithOverriddenTokenBalance() public {
        PonsPool memory p = loadPool(0x3BD9136D51Af679Bd1B11D06B951155543C5449f);
        uint256 tokens = 1_000_000e18;
        // PonsV2LauncherToken is OpenZeppelin v5 ERC20: `_balances` is storage slot 0.
        // This is the override the backend sends; checking balanceOf proves the slot.
        vm.store(p.token, keccak256(abi.encode(SIM, uint256(0))), bytes32(tokens));
        assertEq(IERC20Like(p.token).balanceOf(SIM), tokens, "balance slot 0 assumption is wrong");

        bool zeroForOne = !buyZeroForOne(p);
        (uint256 quoted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: uint128(tokens), hookData: ""})
        );
        PonsRouteSimulator.Result memory r = _simulateRouter(p, zeroForOne, uint128(tokens), uint128(quoted));
        assertTrue(r.success, "sell simulation reverted");
        assertEq(r.inputBalanceBefore, tokens, "token balance override not observed");
        assertEq(r.received, quoted, "simulated sell != quote");
        assertEq(r.spent, tokens);
    }

    function test_routerSimulationReportsMinimumOutputRevert() public {
        PonsPool memory p = loadPool(0x3BD9136D51Af679Bd1B11D06B951155543C5449f);
        uint128 amountIn = 0.01 ether;
        bool zeroForOne = buyZeroForOne(p);
        (uint256 quoted,) = IV4Quoter(OFFICIAL_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({poolKey: p.key, zeroForOne: zeroForOne, exactAmount: amountIn, hookData: ""})
        );
        vm.deal(SIM, amountIn);

        PonsRouteSimulator.Result memory r = _simulateRouter(p, zeroForOne, amountIn, uint128(quoted + 1));
        assertFalse(r.success, "should not succeed above the quote");
        // V4TooLittleReceived(uint256,uint256)
        assertEq(bytes4(r.revertData), bytes4(0x8b063d73), "unexpected revert selector");
        assertEq(r.received, 0);
        assertEq(r.spent, 0);
    }

    function test_curveBuyAndSellSimulation() public {
        IPonsFactory.LaunchedToken memory lt = IPonsFactory(PONS_V2_FACTORY).getLaunchedToken(0x583b10D1912e8D3dEF8709a6C1Cb7aC88fa27fd7);
        IPonsCurve c = IPonsCurve(lt.curve);
        uint256 quoteIn = 0.01 ether;

        (uint256 qr, uint256 tr) = c.getReserves();
        uint256 net = quoteIn - (quoteIn * c.feeBps()) / BPS - (quoteIn * c.creatorTaxBps()) / BPS;
        uint256 expected = (net * BPS * tr) / (qr * BPS + net * BPS);

        vm.deal(SIM, quoteIn);
        vm.prank(SIM);
        PonsRouteSimulator.Result memory buy =
            PonsRouteSimulator(payable(SIM)).simulateCurveBuy(lt.curve, lt.pairToken, lt.token, quoteIn, expected);
        assertTrue(buy.success, "curve buy simulation reverted");
        assertEq(buy.received, expected, "curve buy simulation != formula");
        assertEq(buy.spent, quoteIn);

        (qr, tr) = c.getReserves();
        uint256 gross = (buy.received * BPS * qr) / (tr * BPS + buy.received * BPS);
        uint256 expectedQuote = gross - (gross * c.feeBps()) / BPS - (gross * c.creatorTaxBps()) / BPS;
        PonsRouteSimulator.Result memory sell =
            PonsRouteSimulator(payable(SIM)).simulateCurveSell(lt.curve, lt.pairToken, lt.token, buy.received, expectedQuote);
        assertTrue(sell.success, "curve sell simulation reverted");
        assertEq(sell.received, expectedQuote, "curve sell simulation != formula");
    }

    /// An override written to the wrong slot leaves the balance at zero. The simulator must
    /// make that visible rather than reporting an ordinary revert.
    function test_unappliedBalanceOverrideIsDetectable() public {
        PonsPool memory p = loadPool(0x3BD9136D51Af679Bd1B11D06B951155543C5449f);
        vm.store(p.token, keccak256(abi.encode(SIM, uint256(7))), bytes32(uint256(1e24)));
        bool zeroForOne = !buyZeroForOne(p);
        PonsRouteSimulator.Result memory r = _simulateRouter(p, zeroForOne, uint128(1e24), 0);
        assertEq(r.inputBalanceBefore, 0, "wrong-slot override should not show a balance");
        assertFalse(r.success);
    }

    function _simulateRouter(PonsPool memory p, bool zeroForOne, uint128 amountIn, uint128 minOut)
        internal
        returns (PonsRouteSimulator.Result memory)
    {
        address inputCurrency = Currency.unwrap(zeroForOne ? p.key.currency0 : p.key.currency1);
        address outputCurrency = Currency.unwrap(zeroForOne ? p.key.currency1 : p.key.currency0);

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
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(abi.encodePacked(ACT_SWAP_EXACT_IN_SINGLE, ACT_SETTLE_ALL, ACT_TAKE_ALL), params);

        return PonsRouteSimulator(payable(SIM)).simulateRouter(
            UNIVERSAL_ROUTER, inputCurrency, outputCurrency, amountIn, abi.encodePacked(CMD_V4_SWAP), inputs, block.timestamp + 60
        );
    }
}
