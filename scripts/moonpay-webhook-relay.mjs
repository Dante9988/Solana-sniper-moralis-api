// Loopback-only ingress for an explicitly approved tunnel. No auth routes or UI exposed.
import http from 'node:http';
export const webhookPath = '/api/v1/moonpay/webhook';
export function createRelay(upstreamPort = 8787) {
  return http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== webhookPath) { res.writeHead(404).end(); req.resume(); return; }
    if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) { res.writeHead(415).end(); req.resume(); return; }
    let size = 0; const parts = [];
    req.on('data', (part) => {
      size += part.length;
      if (size > 65536) { if (!res.headersSent) res.writeHead(413).end(); return; }
      parts.push(part);
    });
    req.on('end', () => {
      if (res.headersSent) return;
      const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, path: webhookPath, method: 'POST', headers: {
        'content-type': req.headers['content-type'], 'content-length': size,
        ...(req.headers['moonpay-signature-v2'] ? { 'moonpay-signature-v2': req.headers['moonpay-signature-v2'] } : {}),
        ...(req.headers['content-encoding'] ? { 'content-encoding': req.headers['content-encoding'] } : {}),
      }, timeout: 4500 }, (reply) => { res.writeHead(reply.statusCode ?? 502, { 'content-type': 'application/json' }); reply.pipe(res); });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      upstream.end(Buffer.concat(parts));
    });
    req.on('error', () => { if (!res.headersSent) res.writeHead(400); res.end(); });
  });
}
if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  const server = createRelay();
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  server.listen(8788, '127.0.0.1', () => console.log('MoonPay webhook-only relay on 127.0.0.1:8788'));
}
