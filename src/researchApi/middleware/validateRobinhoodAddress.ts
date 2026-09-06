/**
 * Phase 7B.4 §4.7 — `:tokenAddress` validation for Robinhood Chain routes.
 * Mirrors validateMint.ts's pattern exactly, reusing the same
 * src/assets/assetResolver.ts this repo already has for multi-chain
 * address resolution rather than hand-rolling a parallel regex check here.
 */

import { NextFunction, Request, Response } from "express";
import { resolveAsset } from "../../assets/assetResolver";
import { sendError } from "../contracts/errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      normalizedTokenAddress?: string;
    }
  }
}

export function validateRobinhoodAddress(req: Request, res: Response, next: NextFunction): void {
  const resolved = resolveAsset({ address: req.params.tokenAddress, chain: "ROBINHOOD" });
  if (resolved.status !== "RESOLVED") {
    const reason = "reason" in resolved ? resolved.reason : `resolution status ${resolved.status}`;
    sendError(res, "INVALID_ADDRESS", `invalid Robinhood Chain token address: ${reason}`, req.requestId ?? "");
    return;
  }
  req.normalizedTokenAddress = resolved.asset.normalizedAddress;
  next();
}
