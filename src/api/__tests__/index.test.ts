import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

// src/api/index.ts imports the live Discord client (which calls
// client.login(...) at module scope) and the live Telegram bot singleton
// (which constructs a real Telegraf(TELEGRAM_BOT_TOKEN)). Both are stubbed
// out here so importing this route module never makes a real network call
// or requires real credentials (phase7.txt §5).
vi.mock('../../discord/discord', () => ({ client: {} }));
vi.mock('../../telegram/telegramBot', () => ({ telegramBot: {} }));

vi.mock('../../services/jupiterService', () => ({
  jupiterService: {
    connectWallet: vi.fn(async (userId: string, address: string) => ({
      id: 'wallet-1',
      userId,
      walletAddress: address,
    })),
    getWallet: vi.fn(async () => null),
  },
}));

describe('src/api/index.ts: auth, retired routes, and the public route allowlist', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env.API_AUTH_TOKEN = 'test-token';
    process.env.SOLANA_PAY_BASE_URL = 'https://bot.example.com';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  async function loadApp() {
    const mod = await import('../index');
    mod.setupRoutes();
    return mod.app;
  }

  describe('/api/* auth fails closed', () => {
    it('rejects with 503 when API_AUTH_TOKEN is unset', async () => {
      delete process.env.API_AUTH_TOKEN;
      const app = await loadApp();
      const res = await request(app).get('/api/wallet/someone');
      expect(res.status).toBe(503);
    });

    it('rejects a request with no Authorization header', async () => {
      const app = await loadApp();
      const res = await request(app).get('/api/wallet/someone');
      expect(res.status).toBe(401);
    });

    it('rejects a malformed Authorization header (missing "Bearer ")', async () => {
      const app = await loadApp();
      const res = await request(app).get('/api/wallet/someone').set('Authorization', 'test-token');
      expect(res.status).toBe(401);
    });

    it('rejects an incorrect bearer token', async () => {
      const app = await loadApp();
      const res = await request(app).get('/api/wallet/someone').set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
    });

    it('accepts the correct bearer token', async () => {
      const app = await loadApp();
      const res = await request(app).get('/api/wallet/someone').set('Authorization', 'Bearer test-token');
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(503);
    });
  });

  describe('removed custodial wallet endpoints', () => {
    it('/api/wallet/create no longer exists (404)', async () => {
      const app = await loadApp();
      const res = await request(app)
        .post('/api/wallet/create')
        .set('Authorization', 'Bearer test-token')
        .send({ userId: 'u1' });
      expect(res.status).toBe(404);
    });

    it('/api/wallet/import no longer exists (404)', async () => {
      const app = await loadApp();
      const res = await request(app)
        .post('/api/wallet/import')
        .set('Authorization', 'Bearer test-token')
        .send({ userId: 'u1', privateKey: 'irrelevant' });
      expect(res.status).toBe(404);
    });

    it('/api/wallet/connect (public address only) still works and never echoes back a key field', async () => {
      const app = await loadApp();
      const res = await request(app)
        .post('/api/wallet/connect')
        .set('Authorization', 'Bearer test-token')
        .send({ userId: 'u1', address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' });
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/privateKey|secretKey|walletPk/i);
    });
  });

  describe('public route allowlist', () => {
    it('/health is public', async () => {
      const app = await loadApp();
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    });

    it('/ is public', async () => {
      const app = await loadApp();
      const res = await request(app).get('/');
      expect(res.status).toBe(200);
    });

    it('GET /pay/buy/:intentId is public (unknown id still reaches the handler, not the auth gate)', async () => {
      const app = await loadApp();
      const res = await request(app).get('/pay/buy/does-not-exist');
      expect(res.status).toBe(404); // reached the route handler, not blocked by /api auth (which would be 401/503)
    });

    it('every other route under /api/* is rejected without a token (no undocumented public route)', async () => {
      const app = await loadApp();
      const routes: Array<[string, string]> = [
        ['get', '/api/wallet/u1'],
        ['post', '/api/wallet/connect'],
        ['post', '/api/transaction/buy'],
        ['post', '/api/transaction/sell'],
        ['get', '/api/utils/sol-price'],
        ['get', '/api/config'],
        ['put', '/api/config'],
        ['post', '/api/pnl/check'],
      ];
      for (const [method, path] of routes) {
        const res = await (request(app) as any)[method](path).send({});
        expect(res.status, `${method.toUpperCase()} ${path} should require auth`).toBe(401);
      }
    });
  });

  describe('non-custodial Solana Pay transaction-request endpoints', () => {
    it('POST /api/transaction/buy returns a solana: link, never a signed transaction or a key', async () => {
      const app = await loadApp();
      const res = await request(app)
        .post('/api/transaction/buy')
        .set('Authorization', 'Bearer test-token')
        .send({ tokenAddress: 'So11111111111111111111111111111111111111112', solAmount: 0.1 });
      expect(res.status).toBe(200);
      expect(res.body.data.url).toMatch(/^solana:/);
      expect(JSON.stringify(res.body)).not.toMatch(/privateKey|secretKey/i);
    });
  });
});
