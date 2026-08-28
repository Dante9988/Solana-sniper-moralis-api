/**
 * Phase 6/7B.1 — `npm run api` entrypoint: the canonical `/api/v1` gateway
 * (phase6.txt §3, phase7b1.txt §4).
 *
 * `createApiServer` builds and returns an Express app without listening —
 * tests import it directly (via supertest) with no open port and no live
 * DB. Only the `require.main === module` guard below ever calls `.listen()`,
 * matching the "no import-time startup" discipline used by
 * `forensicsWorkerMain.ts` and the rest of Phase 5D/5E.
 */

import { PrismaClient } from "@prisma/client";
import express, { Express, NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { ApiConfig, loadApiConfig } from "./config";
import { sendError } from "./contracts/errors";
import { AuthenticateDeps, buildSupabaseVerifier } from "./middleware/authenticate";
import { SupabaseVerifierOverrides } from "./middleware/supabaseAuth";
import { createCorsMiddleware } from "./middleware/cors";
import { requestId } from "./middleware/requestId";
import { createDocsRouter } from "./routes/docs";
import { createHealthRouter } from "./routes/health";
import { createJobsRouter } from "./routes/jobs";
import { createMeRouter } from "./routes/me";
import { createTokensRouter } from "./routes/tokens";
import { logger } from "./lib/logger";

export interface CreateApiServerOverrides {
  /** Test-only: inject local JWKS/key material instead of fetching Supabase's real endpoint. Never set outside tests. */
  supabaseVerifierOverrides?: SupabaseVerifierOverrides;
}

export function createApiServer(db: PrismaClient, config: ApiConfig, overrides: CreateApiServerOverrides = {}): Express {
  const app = express();
  const deps: AuthenticateDeps = { supabaseVerifier: buildSupabaseVerifier(config, overrides.supabaseVerifierOverrides) };

  app.use(requestId);
  app.use(createCorsMiddleware(config.cors));
  app.use(express.json());

  app.use((req, _res, next) => {
    logger.info({ requestId: req.requestId, method: req.method, path: req.path }, "request received");
    next();
  });

  app.use("/api/v1", createHealthRouter(db));
  app.use("/api/v1", createDocsRouter());
  app.use("/api/v1", createMeRouter(deps));
  app.use("/api/v1/tokens", createTokensRouter(db, config, deps));
  app.use("/api/v1/jobs", createJobsRouter(db, config, deps));

  app.use((req, res) => {
    sendError(res, "NOT_FOUND", "no such route", req.requestId);
  });

  // Never leak internal error details or stack traces (phase6.txt §3, phase7b1.txt §7).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const requestIdForLog = req.requestId ?? randomUUID();
    logger.error({ requestId: requestIdForLog, err: err instanceof Error ? err.message : String(err) }, "unhandled error");
    sendError(res, "INTERNAL_ERROR", "internal error", requestIdForLog);
  });

  return app;
}

function main(): void {
  const config = loadApiConfig();
  const db = new PrismaClient();
  const app = createApiServer(db, config);

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, publicReads: config.publicReads }, "[api] listening");
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "[api] received signal, shutting down gracefully");
    server.close(() => {
      db.$disconnect().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (require.main === module) {
  main();
}
