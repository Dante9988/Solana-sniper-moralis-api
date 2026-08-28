/**
 * Phase 7B.1 — writes the current OpenAPI document to disk (phase7b1.txt
 * §12 "OpenAPI generation/validation"). Useful for diffing the contract in
 * review, or feeding a future TypeScript client generator. The live
 * `GET /api/v1/openapi.json` route (src/researchApi/routes/docs.ts) always
 * regenerates from the same source — this script is just a convenience
 * snapshot, never the source of truth itself.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { generateOpenApiDocument } from "../contracts/openapi";

function main(): void {
  const document = generateOpenApiDocument();
  const outPath = join(process.cwd(), "openapi.json");
  writeFileSync(outPath, JSON.stringify(document, null, 2) + "\n");
  console.log(`Wrote ${outPath} (${Object.keys(document.paths ?? {}).length} paths)`);
}

main();
