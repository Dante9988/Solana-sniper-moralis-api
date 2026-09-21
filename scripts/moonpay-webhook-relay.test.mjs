import { describe, expect, it } from 'vitest';
import http from 'node:http';

import { createRelay, webhookPath } from './moonpay-webhook-relay.mjs';

/**
 * Phase 7D.5.1 — the relay exists so MoonPay can reach ONE path without a tunnel exposing
 * the whole development API. These tests are what make that claim true rather than
 * aspirational: anything but a POST to the webhook path must 404, and the bytes forwarded
 * must be identical, because the signature is over the exact body MoonPay sent.
 *
 * Uses vitest rather than node:test so the repository keeps a single test gate.
 */
describe('MoonPay webhook relay', () => {
  it('exposes only the webhook POST and forwards bytes unchanged', async () => {
    let seen;
    const upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (b) => chunks.push(b));
      req.on('end', () => {
        seen = { body: Buffer.concat(chunks).toString(), signature: req.headers['moonpay-signature-v2'] };
        res.writeHead(200).end('{}');
      });
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const relay = createRelay(upstream.address().port);
    await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${relay.address().port}`;

    try {
      // Every other API path stays invisible through the tunnel.
      expect((await fetch(`${base}/api/v1/moonpay/orders`)).status).toBe(404);
      // GET on the webhook path is not the webhook.
      expect((await fetch(`${base}${webhookPath}`)).status).toBe(404);
      // A query string must not smuggle a different route past the match.
      expect((await fetch(`${base}${webhookPath}?admin=1`, { method: 'POST' })).status).toBe(404);

      // Deliberately awkward whitespace: a relay that re-serialised would break the signature.
      const body = '{ "type": "test",\n "data": {} }';
      const response = await fetch(`${base}${webhookPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'moonpay-signature-v2': 'test' },
        body,
      });
      expect(response.status).toBe(200);
      expect(seen).toEqual({ body, signature: 'test' });

      // Bounded, so the tunnel cannot be used to push arbitrary volume at the dev machine.
      const tooBig = await fetch(`${base}${webhookPath}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(65_537),
      });
      expect(tooBig.status).toBe(413);
    } finally {
      await new Promise((resolve) => relay.close(resolve));
      await new Promise((resolve) => upstream.close(resolve));
    }
  });
});
