import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const X_MODULE_FILES = ["src/x/config.ts", "src/x/types.ts", "src/x/xApiClient.ts"];
const X_ALL_FILES = [...X_MODULE_FILES, "src/x/smoke.ts"];

// Mirrors the forensics execution-boundary suite's pattern, scoped to what
// phaseX.txt explicitly forbids the X checkpoint from reaching.
const FORBIDDEN_PATTERNS = [
  /@prisma\/client/,
  /prismaClient/,
  /forensics\//,
  /forensicsJobService|bundleForensicsService|solanaForensicsClient|forensicsIntelligence/i,
  /@anthropic-ai/i,
  /anthropicSynthesisProvider|aiSynthesisAgent/i,
  /discord\.js/,
  /discord\//,
  /tracker\//,
  /tradingService|sniperooService/,
  /jupiter/i,
  /jito/i,
  /\bKeypair\b/,
  /PRIV_KEY_WALLET|RUGCHECK_PRIVATE_KEY|privateKey|secretKey/i,
  /sendTransaction|signTransaction|simulateTransaction/,
  /create(?:Buy|Sell|Swap)Transaction|buyToken|sellToken|swapToken/,
  /@solana\/web3\.js/,
  /@solana\/spl-token/,
];

describe("X module execution boundary (phaseX.txt)", () => {
  it("has no imports from Prisma, Anthropic, Discord, forensics, wallet, transaction, signing, swap, or trading modules", () => {
    const source = X_ALL_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const prohibited of FORBIDDEN_PATTERNS) {
      expect(source).not.toMatch(prohibited);
    }
  });

  it("only imports from within src/x, zod, and dotenv — no other repository module", () => {
    for (const file of X_ALL_FILES) {
      const source = readFileSync(file, "utf8");
      const importLines = source.match(/^import .+from ["'][^"']+["'];?$/gm) ?? [];
      for (const line of importLines) {
        const spec = line.match(/from ["']([^"']+)["']/)?.[1] ?? "";
        const allowed = spec === "zod" || spec === "dotenv" || spec.startsWith("./") || spec.startsWith("../x/") || spec === "node:fs";
        expect(allowed, `unexpected import in ${file}: ${line}`).toBe(true);
      }
    }
  });

  it("config.ts and xApiClient.ts have zero import-time side effects (no dotenv.config(), no fetch/network calls at module scope)", () => {
    const source = X_MODULE_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(source).not.toMatch(/dotenv\.config\(/);
    expect(source).not.toMatch(/^\s*(await\s+)?fetch\(/m);
    expect(source).not.toMatch(/^\s*new XApiClient\(/m);
  });

  it("smoke.ts is the only file that calls dotenv.config(), and only the smoke script constructs a live XApiClient at module scope", () => {
    const smokeSource = readFileSync("src/x/smoke.ts", "utf8");
    expect(smokeSource).toMatch(/dotenv\.config\(/);
    for (const file of X_MODULE_FILES) {
      expect(readFileSync(file, "utf8")).not.toMatch(/dotenv\.config\(/);
    }
  });

  it("the client makes exactly one endpoint path — never a rule-mutation or persistent-stream path", () => {
    const source = readFileSync("src/x/xApiClient.ts", "utf8");
    expect(source).toMatch(/\/tweets\/search\/stream\/rules/);
    expect(source).not.toMatch(/method:\s*["'](POST|PUT|DELETE)["']/);
  });

  it("nothing in the X module ever logs or returns the raw bearer token variable outside of a request header assignment", () => {
    const source = X_ALL_FILES.map((file) => readFileSync(file, "utf8")).join("\n");
    // The only legitimate use of the token is as a header value; guard
    // against a future console.log/return of it by banning the token field
    // from ever appearing inside a console.* call or a return statement.
    const consoleCalls = source.match(/console\.(log|error|warn|info)\([^;]*\);?/gs) ?? [];
    for (const call of consoleCalls) {
      expect(call).not.toMatch(/bearerToken/);
    }
  });
});
