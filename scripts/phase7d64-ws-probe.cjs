require('dotenv').config({ quiet: true });
require('ts-node/register');
const { resolveWsEndpoints } = require('../src/pons/rpcEndpoints');
const { WebSocket } = require('ws');
(async () => {
  for (const endpoint of resolveWsEndpoints(process.env)) {
    const result = await new Promise(resolve => {
      const ws = new WebSocket(endpoint.url, { handshakeTimeout: 5000 });
      const samples = [];
      const finish = reason => { clearTimeout(timer); ws.terminate(); resolve({ endpoint: endpoint.label, reason, samples }); };
      const timer = setTimeout(() => finish('probe complete'), 10000);
      ws.on('error', () => finish('connection failed'));
      ws.on('open', () => ws.send(JSON.stringify({ jsonrpc:'2.0', id:1, method:'eth_chainId', params:[] })));
      ws.on('message', raw => { try {
        const m = JSON.parse(raw);
        if (m.id===1) {
          if (m.result !== '0x1237') { finish('wrong chain'); return; }
          ws.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['newHeads']}));
        }
        if (m.params?.result?.number) samples.push({ block:BigInt(m.params.result.number).toString(), timestamp:Number(BigInt(m.params.result.timestamp)), receivedAt:Date.now() });
      } catch {} });
    });
    console.log(JSON.stringify(result));
    if (result.samples.length) break;
  }
})();
