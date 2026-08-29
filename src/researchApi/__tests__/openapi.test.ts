import { describe, expect, it } from "vitest";
import { generateOpenApiDocument } from "../contracts/openapi";

describe("OpenAPI contract generation (phase7b1.txt §4/§7)", () => {
  const doc = generateOpenApiDocument();

  it("generates a valid-shaped OpenAPI 3.1 document", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBeTruthy();
    expect(doc.servers?.[0].url).toBe("https://api.onlypump.me/api/v1");
  });

  it("documents every route required by phase7b1.txt §4/§6", () => {
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/v1/health",
        "/api/v1/ready",
        "/api/v1/me",
        "/api/v1/tokens/{mint}/report",
        "/api/v1/tokens/{mint}/forensics",
        "/api/v1/tokens/{mint}/scans",
        "/api/v1/jobs/{jobKey}",
      ])
    );
  });

  it("documents every route added by phase7b2.txt §2/§4", () => {
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).toEqual(
      expect.arrayContaining([
        "/api/v1/wallets/challenges",
        "/api/v1/wallets/verify",
        "/api/v1/me/wallets",
        "/api/v1/me/wallets/{walletId}",
        "/api/v1/realtime/tickets",
      ])
    );
  });

  it("declares a bearer security scheme and applies it to every authenticated route", () => {
    expect(doc.components?.securitySchemes?.bearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
    const meOperation = (doc.paths?.["/api/v1/me"] as Record<string, unknown>)?.get as { security?: unknown[] };
    expect(meOperation.security).toBeTruthy();
  });

  it("health and openapi.json are documented without a security requirement", () => {
    const healthOperation = (doc.paths?.["/api/v1/health"] as Record<string, unknown>)?.get as { security?: unknown[] };
    expect(healthOperation.security).toBeUndefined();
  });

  it("every documented response references the shared ErrorEnvelope schema for non-2xx codes", () => {
    const reportOp = (doc.paths?.["/api/v1/tokens/{mint}/report"] as Record<string, any>)?.get;
    expect(reportOp.responses["400"].content["application/json"].schema.$ref).toMatch(/ErrorEnvelope/);
    expect(reportOp.responses["401"].content["application/json"].schema.$ref).toMatch(/ErrorEnvelope/);
  });

  it("is deterministic across calls (safe to regenerate on every request to /openapi.json)", () => {
    const again = generateOpenApiDocument();
    expect(JSON.stringify(again)).toBe(JSON.stringify(doc));
  });
});
