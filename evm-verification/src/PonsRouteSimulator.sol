// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/**
 * Phase 7D.3.2 §5 — execution simulation for paper trading.
 *
 * NEVER DEPLOYED. The backend places this runtime code at a synthetic address through an
 * `eth_call` state override, funds that address through the same override, and calls one
 * of the functions below at the quote's pinned block. The trade then runs through the
 * real contracts — UniversalRouter → PoolManager → PonsV2MemeHook, or the real
 * PonsV2BondingCurve — and the result is the synthetic account's measured balance change,
 * not a formula.
 *
 * What this proves: the route executes at that block, for that size, with that minimum.
 * What it does not prove: that any particular wallet holds the funds, has approved Permit2,
 * or would land at the same block. The API says so in `limitations`.
 *
 * No storage of its own and no constructor, so overriding code at a fresh address is
 * sufficient. Verified against real execution in test/fork/PonsRouteSimulatorFork.t.sol.
 */
contract PonsRouteSimulator {
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;

    struct Result {
        bool success;
        /// The input balance the synthetic account started with. The backend compares it to
        /// the amount it overrode, which is how an override that did not apply (unknown
        /// storage layout) is told apart from a trade that genuinely reverted.
        uint256 inputBalanceBefore;
        uint256 spent;
        uint256 received;
        uint256 gasUsed;
        bytes revertData;
    }

    /// Exact-input swap through the UniversalRouter. `commands`/`inputs` are built by the
    /// backend exactly as a wallet would submit them.
    function simulateRouter(
        address router,
        address inputCurrency,
        address outputCurrency,
        uint256 amountIn,
        bytes calldata commands,
        bytes[] calldata inputs,
        uint256 deadline
    ) external returns (Result memory r) {
        if (inputCurrency != address(0)) {
            IERC20Min(inputCurrency).approve(PERMIT2, type(uint256).max);
            IPermit2Min(PERMIT2).approve(inputCurrency, router, type(uint160).max, type(uint48).max);
        }
        uint256 inBefore = _balance(inputCurrency);
        r.inputBalanceBefore = inBefore;
        uint256 outBefore = _balance(outputCurrency);
        uint256 gasBefore = gasleft();

        try IRouterMin(router).execute{value: inputCurrency == address(0) ? amountIn : 0}(commands, inputs, deadline) {
            r.success = true;
        } catch (bytes memory reason) {
            r.revertData = reason;
        }

        r.gasUsed = gasBefore - gasleft();
        r.spent = inBefore - _balance(inputCurrency);
        r.received = _balance(outputCurrency) - outBefore;
    }

    function simulateCurveBuy(address curve, address pairToken, address token, uint256 quoteIn, uint256 minTokensOut)
        external
        returns (Result memory r)
    {
        if (pairToken != address(0)) IERC20Min(pairToken).approve(curve, quoteIn);
        uint256 inBefore = _balance(pairToken);
        r.inputBalanceBefore = inBefore;
        uint256 outBefore = _balance(token);
        uint256 gasBefore = gasleft();

        try ICurveMin(curve).buy{value: pairToken == address(0) ? quoteIn : 0}(quoteIn, minTokensOut, address(this)) {
            r.success = true;
        } catch (bytes memory reason) {
            r.revertData = reason;
        }

        r.gasUsed = gasBefore - gasleft();
        r.spent = inBefore - _balance(pairToken);
        r.received = _balance(token) - outBefore;
    }

    function simulateCurveSell(address curve, address pairToken, address token, uint256 tokensIn, uint256 minQuoteOut)
        external
        returns (Result memory r)
    {
        IERC20Min(token).approve(curve, tokensIn);
        uint256 inBefore = _balance(token);
        r.inputBalanceBefore = inBefore;
        uint256 outBefore = _balance(pairToken);
        uint256 gasBefore = gasleft();

        try ICurveMin(curve).sell(tokensIn, minQuoteOut, address(this)) {
            r.success = true;
        } catch (bytes memory reason) {
            r.revertData = reason;
        }

        r.gasUsed = gasBefore - gasleft();
        r.spent = inBefore - _balance(token);
        r.received = _balance(pairToken) - outBefore;
    }

    function _balance(address currency) internal view returns (uint256) {
        return currency == address(0) ? address(this).balance : IERC20Min(currency).balanceOf(address(this));
    }

    /// Native proceeds from sells and curve refunds arrive here.
    receive() external payable {}
}

interface IERC20Min {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

interface IPermit2Min {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IRouterMin {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface ICurveMin {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256);
}
