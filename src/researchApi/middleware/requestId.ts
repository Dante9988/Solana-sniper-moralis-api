/**
 * Phase 7B.1 — every request gets a server-generated request id, echoed back
 * as `X-Request-Id` and embedded in every error envelope (phase7b1.txt §8).
 * Deliberately does not trust a client-supplied `X-Request-Id` for the id we
 * use in our own logs/errors — an untrusted public client could otherwise
 * inject arbitrary values into structured logs.
 */

import { randomUUID } from "node:crypto";
import { NextFunction, Request, Response } from "express";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
