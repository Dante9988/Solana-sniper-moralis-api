/**
 * Phase 6 — `npm run api` entrypoint (phase6.txt §3, §11-style boundary).
 *
 * `createApiServer` builds and returns an Express app without listening —
 * tests import it directly (via supertest) with no open port and no live
 * DB. Only the `require.main === module` guard below ever calls `.listen()`,
 * matching the "no import-time startup" discipline used by
 * `forensicsWorkerMain.ts` and the rest of Phase 5D/5E.
 */

import { PrismaClient } from "@prisma/client";
import express, { Express, NextFunction, Request, Response } from "express";
import { ApiConfig, loadApiConfig } from "./config";
import { createJobsRouter } from "./routes/jobs";
import { createTokensRouter } from "./routes/tokens";

export function createApiServer(db: PrismaClient, config: ApiConfig): Express {
  const app = express();
  app.use(express.json());

  app.get("/api/v1/health", async (_req, res) => {
    try {
      await db.$queryRaw`SELECT 1`;
      res.json({ status: "ok", db: "reachable" });
    } catch {
      res.status(503).json({ status: "degraded", db: "unreachable" });
    }
  });

  app.use("/api/v1/tokens", createTokensRouter(db, config));
  app.use("/api/v1/jobs", createJobsRouter(db, config));

  // Never leak internal error details or stack traces (phase6.txt §3).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error("api: unhandled error:", err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

function main(): void {
  const config = loadApiConfig();
  const db = new PrismaClient();
  const app = createApiServer(db, config);

  const server = app.listen(config.port, () => {
    console.log(`[api] listening on port ${config.port} (publicReads=${config.publicReads})`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[api] received ${signal}, shutting down gracefully...`);
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
