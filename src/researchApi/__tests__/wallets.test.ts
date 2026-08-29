import { beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { exportJWK, generateKeyPair, JWK, CryptoKey, SignJWT } from "jose";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

vi.mock("../../services/prismaClient", () => ({
  prisma: { asset: { upsert: vi.fn().mockResolvedValue({ id: "asset-1" }) } },
}));

import { createApiServer } from "../server";
import { loadApiConfig } from "../config";

const API_KEY = "test-key-123";
const SUPABASE_URL = "https://test-project.supabase.co";
const ISSUER = `${SUPABASE_URL}/auth/v1`;
const AUDIENCE = "authenticated";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const KID = "test-key-1";

let supabasePrivateKey: CryptoKey;
let supabaseJwks: { keys: JWK[] };

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  supabasePrivateKey = privateKey;
  const jwk = await exportJWK(publicKey);
  jwk.kid = KID;
  jwk.alg = "ES256";
  supabaseJwks = { keys: [jwk] };
});

async function tokenFor(userId: string): Promise<string> {
  return new SignJWT({ email: `${userId}@example.com` })
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(userId)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(supabasePrivateKey);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakeDb() {
  const challenges = new Map<string, any>();
  const challengesByHash = new Map<string, string>();
  const verifiedWallets = new Map<string, any>();
  const userScanRequests = new Map<string, any>();
  const solanaForensicsJobs = new Map<string, any>();
  let idCounter = 0;
  const nextId = () => `id-${++idCounter}`;

  return {
    walletChallenge: {
      create: vi.fn(async ({ data }: any) => {
        const id = nextId();
        const row = { id, consumedAt: null, ...data };
        challenges.set(id, row);
        challengesByHash.set(data.challengeHash, id);
        return row;
      }),
      findUnique: vi.fn(async ({ where: { challengeHash } }: any) => {
        const id = challengesByHash.get(challengeHash);
        return id ? challenges.get(id) : null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = challenges.get(where.id);
        if (!row || row.consumedAt !== null) return { count: 0 };
        row.consumedAt = data.consumedAt;
        return { count: 1 };
      }),
    },
    verifiedWallet: {
      create: vi.fn(async ({ data }: any) => {
        const id = nextId();
        const row = { id, ...data, verifiedAt: new Date() };
        verifiedWallets.set(id, row);
        return row;
      }),
      findUnique: vi.fn(async () => null),
      findMany: vi.fn(async ({ where: { userId } }: any) => [...verifiedWallets.values()].filter((w) => w.userId === userId)),
      deleteMany: vi.fn(async ({ where }: any) => {
        const row = verifiedWallets.get(where.id);
        if (!row || row.userId !== where.userId) return { count: 0 };
        verifiedWallets.delete(where.id);
        return { count: 1 };
      }),
    },
    userScanRequest: {
      upsert: vi.fn(async ({ where, create }: any) => {
        const key = `${where.userId_jobKey.userId}:${where.userId_jobKey.jobKey}`;
        if (!userScanRequests.has(key)) userScanRequests.set(key, { id: nextId(), ...create });
        return userScanRequests.get(key);
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const key = `${where.userId_jobKey.userId}:${where.userId_jobKey.jobKey}`;
        return userScanRequests.get(key) ?? null;
      }),
    },
    solanaForensicsJob: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: nextId(), status: "PENDING", ...data };
        solanaForensicsJobs.set(data.jobKey, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where: { jobKey } }: any) => solanaForensicsJobs.get(jobKey) ?? null),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function buildApp(db: ReturnType<typeof fakeDb>) {
  const config = loadApiConfig({ API_KEYS: API_KEY, SUPABASE_URL } as NodeJS.ProcessEnv);
  return createApiServer(db, config, { supabaseVerifierOverrides: { jwks: supabaseJwks } });
}

describe("POST /api/v1/wallets/challenges and /verify (phase7b2.txt §2)", () => {
  it("requires a Supabase identity — an internal API key is not sufficient", async () => {
    const app = buildApp(fakeDb());
    const res = await request(app)
      .post("/api/v1/wallets/challenges")
      .set("Authorization", `Bearer ${API_KEY}`)
      .send({ address: Keypair.generate().publicKey.toBase58() });
    expect(res.status).toBe(401);
  });

  it("full happy path: challenge -> sign -> verify -> shows up in GET /me/wallets", async () => {
    const db = fakeDb();
    const app = buildApp(db);
    const token = await tokenFor(USER_A);
    const wallet = Keypair.generate();

    const challengeRes = await request(app)
      .post("/api/v1/wallets/challenges")
      .set("Authorization", `Bearer ${token}`)
      .send({ address: wallet.publicKey.toBase58() });
    expect(challengeRes.status).toBe(200);
    expect(challengeRes.body.challengeId).toBeTruthy();
    expect(challengeRes.body.message).toMatch(/prove you own this Solana wallet/i);

    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challengeRes.body.message), wallet.secretKey));

    const verifyRes = await request(app)
      .post("/api/v1/wallets/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ challengeId: challengeRes.body.challengeId, address: wallet.publicKey.toBase58(), signature });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.address).toBe(wallet.publicKey.toBase58());

    const listRes = await request(app).get("/api/v1/me/wallets").set("Authorization", `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveLength(1);
    expect(listRes.body[0].address).toBe(wallet.publicKey.toBase58());
  });

  it("rejects verify with a bad signature via the standard error envelope", async () => {
    const db = fakeDb();
    const app = buildApp(db);
    const token = await tokenFor(USER_A);
    const wallet = Keypair.generate();

    const challengeRes = await request(app).post("/api/v1/wallets/challenges").set("Authorization", `Bearer ${token}`).send({ address: wallet.publicKey.toBase58() });

    const verifyRes = await request(app)
      .post("/api/v1/wallets/verify")
      .set("Authorization", `Bearer ${token}`)
      .send({ challengeId: challengeRes.body.challengeId, address: wallet.publicKey.toBase58(), signature: bs58.encode(new Uint8Array(64)) });
    expect(verifyRes.status).toBe(401);
    expect(verifyRes.body.error.code).toBe("UNAUTHORIZED");
  });

  it("rejects a malformed request body with 400", async () => {
    const app = buildApp(fakeDb());
    const token = await tokenFor(USER_A);
    const res = await request(app).post("/api/v1/wallets/challenges").set("Authorization", `Bearer ${token}`).send({});
    expect(res.status).toBe(400);
  });

  it("DELETE /me/wallets/:walletId only removes the caller's own wallet", async () => {
    const db = fakeDb();
    const app = buildApp(db);
    const tokenA = await tokenFor(USER_A);
    const tokenB = await tokenFor(USER_B);
    const wallet = Keypair.generate();

    const challengeRes = await request(app).post("/api/v1/wallets/challenges").set("Authorization", `Bearer ${tokenA}`).send({ address: wallet.publicKey.toBase58() });
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(challengeRes.body.message), wallet.secretKey));
    const verifyRes = await request(app)
      .post("/api/v1/wallets/verify")
      .set("Authorization", `Bearer ${tokenA}`)
      .send({ challengeId: challengeRes.body.challengeId, address: wallet.publicKey.toBase58(), signature });

    const deniedDelete = await request(app).delete(`/api/v1/me/wallets/${verifyRes.body.id}`).set("Authorization", `Bearer ${tokenB}`);
    expect(deniedDelete.status).toBe(404);

    const okDelete = await request(app).delete(`/api/v1/me/wallets/${verifyRes.body.id}`).set("Authorization", `Bearer ${tokenA}`);
    expect(okDelete.status).toBe(204);
  });
});

describe("user-scoped scan access (phase7b2.txt §3)", () => {
  it("POST /scans records ownership, and GET /jobs/:jobKey denies a different Supabase user", async () => {
    const db = fakeDb();
    const app = buildApp(db);
    const tokenA = await tokenFor(USER_A);
    const tokenB = await tokenFor(USER_B);
    const MINT = "So11111111111111111111111111111111111111112";

    const scanRes = await request(app).post(`/api/v1/tokens/${MINT}/scans`).set("Authorization", `Bearer ${tokenA}`);
    expect(scanRes.status).toBe(202);
    const jobKey = scanRes.body.jobKey;

    const otherUserRead = await request(app).get(`/api/v1/jobs/${jobKey}`).set("Authorization", `Bearer ${tokenB}`);
    expect(otherUserRead.status).toBe(404); // never confirms the job exists to a non-owner

    const ownerRead = await request(app).get(`/api/v1/jobs/${jobKey}`).set("Authorization", `Bearer ${tokenA}`);
    expect(ownerRead.status).toBe(200);
  });

  it("an internal API-key caller keeps unscoped read access to any job (admin/server-to-server, unaffected by user scoping)", async () => {
    const db = fakeDb();
    const app = buildApp(db);
    const tokenA = await tokenFor(USER_A);
    const MINT = "So11111111111111111111111111111111111111112";

    const scanRes = await request(app).post(`/api/v1/tokens/${MINT}/scans`).set("Authorization", `Bearer ${tokenA}`);
    const jobKey = scanRes.body.jobKey;

    const apiKeyRead = await request(app).get(`/api/v1/jobs/${jobKey}`).set("Authorization", `Bearer ${API_KEY}`);
    expect(apiKeyRead.status).toBe(200);
  });
});
