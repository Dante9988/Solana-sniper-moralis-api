// Read-only chart acceptance. Credentials stay in memory; traces are sanitized.
process.env.TZ = 'UTC';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { chromium } = require(process.env.PLAYWRIGHT || '/root/.npm/_npx/e41f203b7505f1fb/node_modules/playwright');
const FRONT = '/root/only-pump-me';
const OUT = path.join(FRONT, 'docs/phase-7d6/evidence/7d6.4/verified');
const TOKEN = process.env.TOKEN || '0xa67a3eebf0ae8a935848bb47993b9a6d68751a23';
const RBD = '0xb41c7ac9d46a980f8bdf1894b392a2a07ec9992a';
const BASE = 'http://localhost:8080';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const quantiles = values => {
  const a = values.filter(v => Number.isFinite(v) && v >= 0).sort((x,y) => x-y);
  return { n: a.length, p50Ms: a[Math.ceil(a.length*.5)-1] ?? null, p95Ms: a[Math.ceil(a.length*.95)-1] ?? null, maxMs: a.at(-1) ?? null };
};
const same = (a,b) => ['startTime','open','high','low','close','volumeToken','volumeQuote','trades'].every(k => a?.[k] === b?.[k]);
let browser, db;
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  db = new Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
  browser = await chromium.launch({ headless: true });
  const report = { at: new Date().toISOString(), token: TOKEN, stages: [], errors: [] };
  for (const signedIn of process.env.GUEST_ONLY ? [false] : [false,true]) {
    const name = signedIn ? 'signed-in' : 'guest';
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 960 }, recordVideo: { dir: path.join(OUT, name) } });
    const page = await ctx.newPage();
    // Do not record login credentials in traces.
    if (signedIn) {
      const creds = require('dotenv').parse(fs.readFileSync(path.join(FRONT,'.env.e2e.local')));
      await page.goto(`${BASE}/auth`);
      await page.getByLabel('Email', { exact: true }).first().fill(creds.E2E_USER_A_EMAIL);
      await page.getByLabel('Password', { exact: true }).first().fill(creds.E2E_USER_A_PASSWORD);
      await page.getByRole('button', { name: 'Sign In', exact: true }).click();
      await page.waitForURL(u => !u.pathname.startsWith('/auth'), { timeout: 30000 });
    }
    await ctx.tracing.start({ screenshots: true, snapshots: true });
    const frames = [], renders = [], requests = [], errors = [], sockets = [], historyResponses = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('response', async r => {
      const u = new URL(r.url());
      if (u.pathname.endsWith('/candles') && r.status()===200) { try { const data=await r.json(); historyResponses.push({ at:Date.now(),resolution:data.resolution,count:data.candles.length,first:data.candles[0]?.startTime,last:data.candles.at(-1)?.startTime,nextCursor:data.nextCursor }); } catch {} }
      if (u.port === '8787' || /supabase/.test(u.host)) requests.push({ at: Date.now(), path: u.pathname, status: r.status(), resolution: u.searchParams.get('resolution') });
    });
    page.on('websocket', ws => {
      if (!ws.url().includes('/api/v1/realtime')) return;
      sockets.push({ at: Date.now(), mode: ws.url().includes('/market') ? 'public' : 'authenticated' });
      ws.on('framereceived', e => { try { const f=JSON.parse(e.payload); if (f.type === 'token.candle.updated' || f.type === 'candles.subscribed') frames.push({ receivedAt: Date.now(), ...f }); } catch {} });
    });
    await page.exposeFunction('chartRendered', x => renders.push(x));
    await page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.__marketSockets = [];
      window.WebSocket = class extends NativeSocket {
        constructor(...args) { super(...args); if (String(args[0]).includes('/api/v1/realtime')) window.__marketSockets.push(this); }
      };
      let last = '';
      const observe = () => {
        const legend = document.querySelector('[data-testid="ohlcv-legend"]');
        const raw = legend?.getAttribute('data-candle');
        if (raw && raw !== last) {
          last = raw;
          requestAnimationFrame(() => window.chartRendered({ at: Date.now(), candle: JSON.parse(raw), legend: legend.textContent.replace(/\s+/g,' ').trim() }));
        }
      };
      new MutationObserver(observe).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    });
    const start = Date.now();
    await page.goto(`${BASE}/token/robinhood/${TOKEN}`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('ohlcv-legend').waitFor({ timeout: 60000 });
    await page.getByTestId('resolution-1m').click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="ohlcv-legend"]')?.getAttribute('data-candle') || '{}').resolution === '1m', null, { timeout: 60000 });
    console.log(`${name}: live observation started`);
    await sleep(Number(process.env.WATCH_MS || 90000));
    await page.screenshot({ path: path.join(OUT,`${name}-1m.png`) });
    const liveEnd = Date.now();
    const sequence = ['15m','5m','1m','15s','5s','1s','1m','15m'];
    const histories = {};
    // Warm caches, then exercise 20 rapid cycles while real push stays active.
    for (const resolution of [...new Set(sequence)]) {
      await page.getByTestId(`resolution-${resolution}`).click();
      await page.waitForFunction(r => JSON.parse(document.querySelector('[data-testid="ohlcv-legend"]')?.getAttribute('data-candle') || '{}').resolution === r, resolution, { timeout: 60000 });
      const response = await db.query('SELECT count(*) AS n FROM "MarketCandle" WHERE "tokenAddress"=$1 AND resolution=$2', [TOKEN, { '1s':'S1','5s':'S5','15s':'S15','1m':'M1','5m':'M5','15m':'M15' }[resolution]]);
      histories[resolution] = { stored: Number(response.rows[0].n) };
      await page.screenshot({ path: path.join(OUT,`${name}-${resolution}.png`) });
    }
    for (let cycle=0; cycle<20; cycle++) {
      for (const resolution of sequence) { await page.getByTestId(`resolution-${resolution}`).click(); await sleep(65); }
    }
    console.log(`${name}: 20 switching cycles complete`);
    await page.getByTestId('resolution-1m').click();
    await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="ohlcv-legend"]')?.getAttribute('data-candle') || '{}').resolution === '1m');
    await sleep(1500);
    const disconnectedAt = Date.now();
    const closedSockets = await page.evaluate(() => {
      const open = window.__marketSockets.filter(s => s.readyState === WebSocket.OPEN);
      open.forEach(s => s.close(4000, 'acceptance reconnect'));
      return open.length;
    });
    assert(closedSockets > 0, 'close an actual open market transport');
    for (let i=0;i<120;i++) {
      if (frames.some(f=>f.receivedAt>disconnectedAt&&f.type==='candles.subscribed'&&f.resolution==='1m') && historyResponses.some(h=>h.at>disconnectedAt&&h.resolution==='1m')) break;
      await sleep(250);
    }
    const reconnect = {
      disconnectedAt, closedSockets,
      openedNewSocket: sockets.some(s=>s.at>disconnectedAt),
      acknowledged: frames.some(f=>f.receivedAt>disconnectedAt&&f.type==='candles.subscribed'&&f.resolution==='1m'),
      reconciledRest: historyResponses.some(h=>h.at>disconnectedAt&&h.resolution==='1m'),
    };
    assert(reconnect.openedNewSocket && reconnect.acknowledged && reconnect.reconciledRest, 'reconnect must acknowledge and reconcile REST');
    const txs = await page.locator('a[href*="/tx/"]').evaluateAll(as => as.map(a => a.getAttribute('href')));
    const trades = (await db.query('SELECT "sourceTxHash", "sourceIndex", "sourceHeight"::text, "sourceTimestamp", "observedAt", "tokenAmount"::text, "quoteAmount"::text FROM "ChainTrade" WHERE "tokenAddress"=$1 AND "canonicalStatus"=\'CANONICAL\' AND "sourceTimestamp">=$2 AND "sourceTimestamp"<$3 ORDER BY "sourceHeight", "sourceIndex"', [TOKEN,new Date(start),new Date(liveEnd)])).rows;
    const liveFrames = frames.filter(f=>f.type==='token.candle.updated' && f.data.resolution==='1m' && f.receivedAt<=liveEnd);
    const matched = liveFrames.flatMap(f=>{const rendered=renders.find(r=>r.at>=f.receivedAt-20 && r.candle.resolution==='1m' && same(r.candle,f.data.candle)); return rendered ? [{ f, rendered }] : [];});
    const latency = {
      // observedAt is the ingestion timestamp stored by the existing adapter;
      // commit is later. Report this basis explicitly, never label it exact commit.
      chainToIndexedObservedAt: quantiles(trades.map(t=>new Date(t.observedAt)-new Date(t.sourceTimestamp))),
      indexedObservedAtToCandle: quantiles(trades.map(t=>{const bucket=Math.floor(new Date(t.sourceTimestamp).getTime()/60000)*60; const f=liveFrames.find(f=>f.data.candle.startTime===bucket && f.data.lastSourceHeight && BigInt(f.data.lastSourceHeight)>=BigInt(t.sourceHeight) && new Date(f.data.candleCommittedAt)>=new Date(t.observedAt)); return f ? new Date(f.data.candleCommittedAt)-new Date(t.observedAt) : NaN;})),
      candleToBrowser: quantiles(liveFrames.map(f=>f.receivedAt-new Date(f.data.candleCommittedAt || f.data.candle.updatedAt))),
      candleToRendered: quantiles(matched.map(({f,rendered})=>rendered.at-new Date(f.data.candleCommittedAt || f.data.candle.updatedAt))),
      candleToPublished: quantiles(liveFrames.map(f=>new Date(f.occurredAt)-new Date(f.data.candleCommittedAt || f.data.candle.updatedAt))),
      publishedToBrowser: quantiles(liveFrames.map(f=>f.receivedAt-new Date(f.occurredAt))),
    };
    const entry = { name, start, liveEnd, reconnect, historyResponses, sockets, latency, canonicalTrades:trades.length, liveCandleEvents:liveFrames.length, exactRenderedMatches:matched.length, switchCycles:20, duplicateTradeLinks:txs.length-new Set(txs).size, histories, errors, requests, frames, renders, trades };
    if (signedIn) {
      await page.getByTestId('sign-out').click(); await sleep(3000);
      await page.goto(`${BASE}/token/robinhood/${TOKEN}`); await sleep(3000);
      entry.afterSignOutPublic = sockets.some(s=>s.mode==='public');
    }
    assert.deepEqual(errors, []);
    assert.equal(entry.duplicateTradeLinks, 0);
    assert(!requests.some(r=>r.status===429));
    assert(matched.length>0 && liveFrames.length>0, 'observe real canonical pushes and rendered matches');
    if (signedIn) assert(entry.afterSignOutPublic);
    report.stages.push(entry);
    fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,null,2));
    // Keep raw trace out of the repository; sanitize network authorization and
    // single-use ticket URLs before moving it into the evidence directory.
    const raw = `/tmp/phase7d64-${name}-trace.zip`;
    await ctx.tracing.stop({ path: raw });
    const { spawnSync } = require('node:child_process');
    const sanitized = spawnSync('python3', [path.join(__dirname,'phase7d64-sanitize-trace.py'),raw,path.join(OUT,`${name}-trace.zip`)], { stdio:'inherit' });
    if (sanitized.status) throw new Error('Trace sanitization failed');
    fs.unlinkSync(raw);
    if (signedIn) {
      const creds = require('dotenv').parse(fs.readFileSync(path.join(FRONT,'.env.e2e.local')));
      const before=Date.now();
      // Tracing is stopped before credentials enter the page. Exercise auth
      // on a mounted chart to verify the gateway's guest -> ticket transition.
      await page.evaluate(async ({email,password})=>{
        const {supabase}=await import('/src/integrations/supabase/client.ts');
        const {error}=await supabase.auth.signInWithPassword({email,password}); if(error)throw new Error(error.message);
      },{email:creds.E2E_USER_A_EMAIL,password:creds.E2E_USER_A_PASSWORD});
      await sleep(3000);
      entry.afterSignInAuthenticated=sockets.some(s=>s.mode==='authenticated'&&s.at>=before);
      assert(entry.afterSignInAuthenticated);
      fs.writeFileSync(path.join(OUT,'acceptance.json'),JSON.stringify(report,null,2));
    }
    await ctx.close();
    console.log(JSON.stringify({ name, latency, events:liveFrames.length, matches:matched.length, errors, status429:requests.filter(r=>r.status===429).length }));
  }
  // Separate mobile rendering of the required full RBD identity.
  const mobile = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true });
  const p = await mobile.newPage(); await p.goto(`${BASE}/token/robinhood/${RBD}`); await p.getByTestId('resolution-5s').click(); await sleep(3000);
  await p.screenshot({path:path.join(OUT,'mobile-rbd-5s.png'),fullPage:true}); await mobile.close();
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(async()=>{await browser?.close();await db?.end();});
