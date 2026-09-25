// Read-only sandbox diagnostic. Never prints credentials, URLs with keys or customer data.
require('dotenv').config();
async function main() {
  const secret = process.env.MOONPAY_SECRET_KEY;
  const pub = process.env.MOONPAY_PUBLISHABLE_KEY;
  if (!secret?.startsWith('sk_test_') || !pub?.startsWith('pk_test_')) throw new Error('Sandbox keys required');
  const url = new URL('https://api.moonpay.com/v1/transactions');
  url.searchParams.set('externalTransactionId', `onlypump-readiness-${require('node:crypto').randomUUID()}`);
  url.searchParams.set('limit', '2');
  const result = await fetch(url, { headers: { Authorization: `Api-Key ${secret}` }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  const data = result.ok ? await result.json() : null;
  console.log(JSON.stringify({ check: 'authenticated sandbox transaction lookup', httpStatus: result.status, arrayResponse: Array.isArray(data), matchesSyntheticReference: Array.isArray(data) ? data.length : null }));
  const currencies = await fetch(`https://api.moonpay.com/v3/currencies?apiKey=${encodeURIComponent(pub)}`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  const entries = currencies.ok ? await currencies.json() : [];
  console.log(JSON.stringify({ check: 'currency capability', httpStatus: currencies.status, currencies: Array.isArray(entries) ? entries.filter((c) => ['eth','sol'].includes(c.code)).map((c) => ({ code: c.code, supportsTestMode: c.supportsTestMode, isSuspended: c.isSuspended, metadata: c.metadata })) : [] }));
}
main().catch(() => { console.error('Read-only provider diagnostic failed (credentials and response suppressed).'); process.exitCode = 1; });
