/**
 * Phase 6 — `:mint` validation (phase6.txt §3). Reuses the Phase 4
 * `assetResolver` so a future EVM surface needs no reshaping; rejects early
 * with 400 rather than letting an invalid address reach a Prisma query.
 */

import { NextFunction, Request, Response } from "express";
import { resolveAsset } from "../../assets/assetResolver";
import { sendError } from "../contracts/errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      normalizedMint?: string;
    }
  }
}

export function validateMint(req: Request, res: Response, next: NextFunction): void {
  const resolved = resolveAsset({ address: req.params.mint, chain: "SOLANA" });
  if (resolved.status !== "RESOLVED") {
    const reason = "reason" in resolved ? resolved.reason : `resolution status ${resolved.status}`;
    sendError(res, "INVALID_MINT", `invalid Solana mint: ${reason}`, req.requestId ?? "");
    return;
  }
  req.normalizedMint = resolved.asset.normalizedAddress;
  next();
}
