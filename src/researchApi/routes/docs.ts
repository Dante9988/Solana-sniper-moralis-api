/**
 * Phase 7B.1 — GET /api/v1/openapi.json and GET /api/v1/docs (phase7b1.txt §4/§6).
 * Both public — documentation is not sensitive, and a client needs the spec
 * before it can even know how to authenticate.
 */

import { Router } from "express";
// swagger-ui-express ships no ESM/TS-friendly default export; require matches
// the exact pattern already used by src/api/index.ts for the same package.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const swaggerUi = require("swagger-ui-express");
import { generateOpenApiDocument } from "../contracts/openapi";

export function createDocsRouter(): Router {
  const router = Router();
  const document = generateOpenApiDocument();

  router.get("/openapi.json", (_req, res) => {
    res.json(document);
  });

  router.use("/docs", swaggerUi.serve, swaggerUi.setup(document));

  return router;
}
