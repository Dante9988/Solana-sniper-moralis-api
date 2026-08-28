import { describe, expect, it, beforeAll } from "vitest";
import { exportJWK, generateKeyPair, JWK, CryptoKey, SignJWT } from "jose";
import { createSupabaseJwtVerifier, SupabaseAuthError } from "../middleware/supabaseAuth";
import { SupabaseAuthConfig } from "../config";

// All verification here runs against LOCAL test keys via the `jwks` override
// — never Supabase's real endpoint or any network call (phase7b1.txt §11).

const ISSUER = "https://test-project.supabase.co/auth/v1";
const AUDIENCE = "authenticated";
const SUBJECT = "11111111-1111-4111-8111-111111111111";
const KID = "test-key-1";

describe("createSupabaseJwtVerifier (local test keys, no network)", () => {
  let privateKey: CryptoKey;
  let jwks: { keys: JWK[] };
  let config: SupabaseAuthConfig;

  beforeAll(async () => {
    const { privateKey: priv, publicKey: pub } = await generateKeyPair("ES256");
    privateKey = priv;
    const publicJwk = await exportJWK(pub);
    publicJwk.kid = KID;
    publicJwk.alg = "ES256";
    jwks = { keys: [publicJwk] };

    config = {
      projectUrl: "https://test-project.supabase.co",
      issuer: ISSUER,
      jwksUrl: "https://test-project.supabase.co/auth/v1/.well-known/jwks.json",
      audience: AUDIENCE,
    };
  });

  async function signToken(opts: {
    issuer?: string;
    audience?: string;
    subject?: string | null;
    expSeconds?: number;
    signWithDifferentKey?: boolean;
    email?: string;
  } = {}): Promise<string> {
    const key = opts.signWithDifferentKey ? (await generateKeyPair("ES256")).privateKey : privateKey;
    let jwt = new SignJWT({ email: opts.email ?? "user@example.com" })
      .setProtectedHeader({ alg: "ES256", kid: KID })
      .setIssuedAt()
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setExpirationTime(opts.expSeconds ?? Math.floor(Date.now() / 1000) + 3600);
    if (opts.subject !== null) jwt = jwt.setSubject(opts.subject ?? SUBJECT);
    return jwt.sign(key);
  }

  it("accepts a validly signed, current, correctly issued and audienced token", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    const token = await signToken();
    const identity = await verifier.verify(token);
    expect(identity.userId).toBe(SUBJECT);
    expect(identity.email).toBe("user@example.com");
  });

  it("rejects an expired token", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    const token = await signToken({ expSeconds: Math.floor(Date.now() / 1000) - 3600 });
    await expect(verifier.verify(token)).rejects.toThrow(SupabaseAuthError);
  });

  it("rejects a token from the wrong issuer", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    const token = await signToken({ issuer: "https://attacker-project.supabase.co/auth/v1" });
    await expect(verifier.verify(token)).rejects.toThrow(SupabaseAuthError);
  });

  it("rejects a token with the wrong audience when an audience is configured", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    const token = await signToken({ audience: "some-other-app" });
    await expect(verifier.verify(token)).rejects.toThrow(SupabaseAuthError);
  });

  it("rejects a token signed with a key not in the JWKS (invalid signature)", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    const token = await signToken({ signWithDifferentKey: true });
    await expect(verifier.verify(token)).rejects.toThrow(SupabaseAuthError);
  });

  it("rejects a malformed token", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    await expect(verifier.verify("not-a-jwt-at-all")).rejects.toThrow(SupabaseAuthError);
  });

  it("rejects an unsigned (alg: none) token — never accepts a merely-decoded JWT", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    // Hand-construct an alg:none token: header.payload. with no signature.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: SUBJECT, iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600 })).toString(
      "base64url"
    );
    const unsignedToken = `${header}.${payload}.`;
    await expect(verifier.verify(unsignedToken)).rejects.toThrow(SupabaseAuthError);
  });

  it("rejects a token missing a subject claim", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks });
    const token = await signToken({ subject: null });
    await expect(verifier.verify(token)).rejects.toThrow(SupabaseAuthError);
  });

  it("HS256 path: verifies against the configured shared secret, and rejects a token signed with the wrong secret", async () => {
    const hsConfig: SupabaseAuthConfig = { ...config, hsSecret: "correct-shared-secret-at-least-32-bytes-long" };
    const verifier = createSupabaseJwtVerifier(hsConfig, { jwks });

    const { SignJWT: SignJWTLocal } = await import("jose");
    const goodToken = await new SignJWTLocal({ email: "user@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode(hsConfig.hsSecret));
    const identity = await verifier.verify(goodToken);
    expect(identity.userId).toBe(SUBJECT);

    const badToken = await new SignJWTLocal({ email: "user@example.com" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode("wrong-secret-entirely-different-value"));
    await expect(verifier.verify(badToken)).rejects.toThrow(SupabaseAuthError);
  });

  it("rejects an HS256 token when SUPABASE_JWT_SECRET is not configured", async () => {
    const verifier = createSupabaseJwtVerifier(config, { jwks }); // no hsSecret
    const { SignJWT: SignJWTLocal } = await import("jose");
    const token = await new SignJWTLocal({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(SUBJECT)
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(new TextEncoder().encode("some-secret"));
    await expect(verifier.verify(token)).rejects.toThrow(SupabaseAuthError);
  });
});
