#!/usr/bin/env node
/**
 * Phase 7D.3 §3 — contract-drift check.
 *
 * `openapi.json` is generated from the Zod schemas, and the frontend pins a copy of it to
 * generate its API types. If the two drift, the frontend's types silently disagree with
 * what the API returns — which is exactly what happened in 7D.2: the pinned snapshot
 * documented 18 fields while the live route returned 29, so the frontend was blind to
 * name, symbol and logoUrl and fell back to placeholders that looked like missing data.
 *
 * This regenerates the document in memory and compares it to the committed file.
 * Exit 0 = in sync, exit 1 = drift (with a summary of what changed).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const COMMITTED = "openapi.json";

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(COMMITTED)) {
  fail(`${COMMITTED} is missing. Run: npm run openapi:generate`);
}

// Regenerate into a temp file rather than trusting whatever is on disk.
const tmp = `.openapi-drift-${Date.now()}.json`;
try {
  execFileSync("npx", ["ts-node", "-e", `
    import { writeFileSync } from "node:fs";
    import { generateOpenApiDocument } from "./src/researchApi/contracts/openapi";
    writeFileSync(${JSON.stringify(tmp)}, JSON.stringify(generateOpenApiDocument(), null, 2) + "\\n");
  `], { stdio: "pipe" });
} catch (error) {
  fail(`could not regenerate the OpenAPI document:\n${error.stderr?.toString() ?? error.message}`);
}

const fresh = JSON.parse(readFileSync(tmp, "utf8"));
const committed = JSON.parse(readFileSync(COMMITTED, "utf8"));
execFileSync("rm", ["-f", tmp]);

const freshPaths = Object.keys(fresh.paths ?? {}).sort();
const committedPaths = Object.keys(committed.paths ?? {}).sort();
const addedPaths = freshPaths.filter((p) => !committedPaths.includes(p));
const removedPaths = committedPaths.filter((p) => !freshPaths.includes(p));

const freshSchemas = fresh.components?.schemas ?? {};
const committedSchemas = committed.components?.schemas ?? {};
const fieldDrift = [];
for (const name of Object.keys(freshSchemas)) {
  const a = Object.keys(freshSchemas[name]?.properties ?? {}).sort();
  const b = Object.keys(committedSchemas[name]?.properties ?? {}).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    fieldDrift.push({
      name,
      added: a.filter((f) => !b.includes(f)),
      removed: b.filter((f) => !a.includes(f)),
    });
  }
}

if (addedPaths.length || removedPaths.length || fieldDrift.length) {
  console.error("\n✗ openapi.json is out of date with the Zod schemas.\n");
  for (const p of addedPaths) console.error(`  + path    ${p}`);
  for (const p of removedPaths) console.error(`  - path    ${p}`);
  for (const d of fieldDrift) {
    if (d.added.length) console.error(`  + ${d.name}: ${d.added.join(", ")}`);
    if (d.removed.length) console.error(`  - ${d.name}: ${d.removed.join(", ")}`);
  }
  console.error("\nRun `npm run openapi:generate`, then copy openapi.json to the");
  console.error("frontend's openapi/backend.json and run `npm run api:codegen` there.\n");
  process.exit(1);
}

console.log(`✓ openapi.json matches the Zod schemas (${freshPaths.length} paths, ${Object.keys(freshSchemas).length} schemas).`);
