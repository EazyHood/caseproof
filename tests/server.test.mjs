import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createCaseproofServer } from '../server.mjs';
import { fixtureCase } from '../fixtures/cases.js';

async function running(t, options) {
  const server = createCaseproofServer(options);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  return { server, port, origin: `http://127.0.0.1:${port}` };
}

function request(app, path, { method = 'GET', body, headers = {}, origin = true, chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const outgoing = { ...(method === 'POST' ? { 'Content-Type': 'application/json', ...(origin ? { Origin: app.origin } : {}) } : {}), ...headers };
    if (payload !== undefined && !chunked) outgoing['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ hostname: '127.0.0.1', port: app.port, method, path, headers: outgoing }, res => {
      let text = '';
      res.setEncoding('utf8'); res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let data; try { data = JSON.parse(text); } catch { data = text; } resolve({ status: res.statusCode, data, headers: res.headers }); });
    });
    req.on('error', reject);
    if (payload !== undefined && chunked) { req.write(payload.slice(0, 10000)); req.write(payload.slice(10000)); req.end(); }
    else req.end(payload);
  });
}

const inspect = { orderId: 'FIXTURE-ORDER-001', invoiceId: 'CP-1042', value: '49.00', currencyCode: 'USD' };
const env = { PAYPAL_CLIENT_ID: 'TEST-CLIENT-NOT-REAL', PAYPAL_CLIENT_SECRET: 'TEST-SECRET-NOT-REAL', CASEPROOF_OLLAMA_MODEL: 'test-model' };
const envelope = () => ({ ...fixtureCase('paid').order, source: 'paypal-sandbox', status: 200, fetchedAt: new Date().toISOString() });
const proposalFor = result => ({
  action: result.allowedActions[0], claimedState: result.state, claimedCompletedMinor: result.amounts.completedMinor,
  currencyCode: result.amounts.currencyCode, evidenceIds: result.evidence.map(item => item.id), reasonCodes: [`state:${result.state}`],
  explanation: 'Injected test proposal about the freshly reconciled evidence.'
});

test('default config does not read ambient credentials and never exposes values', async t => {
  const app = await running(t);
  const response = await request(app, '/api/config');
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { sandboxConfigured: false, aiConfigured: false });
  const configured = await running(t, { env });
  const flags = await request(configured, '/api/config');
  assert.deepEqual(flags.data, { sandboxConfigured: true, aiConfigured: true });
  assert.ok(!JSON.stringify(flags.data).includes('TEST-SECRET'));
});

test('six case routes recompute labeled synthetic results without contacting adapters', async t => {
  const app = await running(t, { env, clientFactory: () => { throw new Error('Should not call'); }, generateFactory: () => { throw new Error('Should not call'); } });
  const list = await request(app, '/api/cases');
  assert.equal(list.status, 200);
  assert.equal(list.data.cases.length, 6);
  for (const entry of list.data.cases) {
    assert.ok(entry.title && entry.summary);
    const detail = await request(app, `/api/cases/${entry.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.data.result.mode, 'fixture');
    assert.equal(detail.data.provenance.kind, 'synthetic-fixture');
  }
  const paid = await request(app, '/api/cases/duplicate-webhook');
  assert.equal(paid.data.result.duplicateEvents, 1);
  assert.equal(paid.data.result.amounts.completedMinor, '4900');
  assert.equal((await request(app, '/api/cases/no-such-case')).status, 404);
});

test('host checks reject DNS rebinding, suffix tricks and the wrong local port', async t => {
  const app = await running(t);
  for (const Host of [`evil.example:${app.port}`, `127.0.0.1.evil.example:${app.port}`, '127.0.0.1:1', 'localhost']) {
    const response = await request(app, '/api/config', { headers: { Host } });
    assert.equal(response.status, 403);
    assert.equal(response.data.error.code, 'HOST_REJECTED');
  }
  assert.equal((await request(app, '/api/config', { headers: { Host: `localhost:${app.port}` } })).status, 200);
});

test('POST requires an exact present same-origin header', async t => {
  const app = await running(t);
  for (const options of [{ origin: false }, { headers: { Origin: 'null' } }, { headers: { Origin: 'https://evil.example' } }, { headers: { Origin: `http://localhost:${app.port}` } }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }]) {
    const response = await request(app, '/api/analyze', { method: 'POST', body: { caseId: 'duplicate-webhook' }, ...options });
    assert.equal(response.status, 403);
    assert.equal(response.data.error.code, 'ORIGIN_REJECTED');
  }
});

test('POST enforces JSON object, content type, encoding and byte limit with and without length', async t => {
  const app = await running(t);
  assert.equal((await request(app, '/api/analyze', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(app, '/api/analyze', { method: 'POST', body: '{}', headers: { 'Content-Encoding': 'gzip' } })).status, 415);
  for (const body of ['{', 'null', '[]', '1']) assert.equal((await request(app, '/api/analyze', { method: 'POST', body })).status, 400);
  for (const chunked of [false, true]) assert.equal((await request(app, '/api/analyze', { method: 'POST', body: JSON.stringify({ caseId: 'x'.repeat(17000) }), chunked })).status, 413);
});

test('missing configuration returns explicit 503 without fake outputs or calls', async t => {
  let called = false;
  const app = await running(t, { clientFactory: () => { called = true; }, generateFactory: () => { called = true; } });
  const ai = await request(app, '/api/analyze', { method: 'POST', body: { caseId: 'duplicate-webhook' } });
  assert.equal(ai.status, 503); assert.equal(ai.data.error.code, 'AI_NOT_CONFIGURED');
  const paypal = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  assert.equal(paypal.status, 503); assert.equal(paypal.data.error.code, 'SANDBOX_NOT_CONFIGURED');
  assert.equal(called, false);
});

test('inspect input validation refuses evidence, upstream URL and unsupported amounts before any call', async t => {
  let called = false;
  const app = await running(t, { env, clientFactory: () => { called = true; } });
  const invalid = [
    { ...inspect, source: 'paypal-sandbox' }, { ...inspect, events: [] }, { ...inspect, baseUrl: 'https://evil.example' },
    { ...inspect, orderId: '../something' }, { ...inspect, value: 49 }, { ...inspect, value: '0.00' },
    { ...inspect, value: '49.001' }, { ...inspect, currencyCode: 'JPY' }, { ...inspect, invoiceId: 'bad\ninvoice' }
  ];
  for (const body of invalid) assert.equal((await request(app, '/api/inspect', { method: 'POST', body })).status, 400);
  assert.equal(called, false);
});

test('inspect calls only getOrder and injected source claims cannot become authentic sandbox evidence', async t => {
  const methods = [];
  const app = await running(t, { env, clientFactory: options => {
    assert.equal(options.clientId, env.PAYPAL_CLIENT_ID);
    assert.equal(typeof options.fetchImpl, 'function');
    return { getOrder: async id => { methods.push(`get:${id}`); return envelope(); }, createOrder: () => methods.push('create'), captureOrder: () => methods.push('capture') };
  } });
  const response = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  assert.equal(response.status, 200);
  assert.equal(response.data.result.state, 'paid');
  assert.equal(response.data.result.mode, 'fixture');
  assert.equal(response.data.provenance.kind, 'synthetic-fixture');
  assert.match(response.data.provenance.notice, /Injected test adapter/);
  assert.deepEqual(methods, [`get:${inspect.orderId}`]);
  assert.ok(!JSON.stringify(response.data).includes(env.PAYPAL_CLIENT_SECRET));
});

test('invalid upstream wrappers are rejected and errors never expose credentials or raw bodies', async t => {
  for (const received of [{ ...envelope(), source: 'production' }, { ...envelope(), status: 500 }, { ...envelope(), fetchedAt: 'invalid' }]) {
    const app = await running(t, { env, clientFactory: () => ({ getOrder: async () => received }) });
    const response = await request(app, '/api/inspect', { method: 'POST', body: inspect });
    assert.equal(response.status, 502);
    assert.equal(response.data.error.code, 'INVALID_SANDBOX_RESPONSE');
  }
  const app = await running(t, { env, clientFactory: () => ({ getOrder: async () => { throw new Error(env.PAYPAL_CLIENT_SECRET); } }) });
  const response = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(response.data).includes(env.PAYPAL_CLIENT_SECRET));
});

test('analyze recomputes the selected fixture and validates a labeled injected model proposal', async t => {
  const app = await running(t, { env, generateFactory: () => async ({ messages }) => {
    const state = JSON.parse(messages[1].content);
    assert.equal(state.amounts.completedMinor, '4900');
    return { action: 'capture_order', claimedState: state.state, claimedCompletedMinor: '9800', currencyCode: 'USD', evidenceIds: ['invented'], reasonCodes: ['state:paid'], explanation: 'An intentionally invalid model proposal.' };
  } });
  const response = await request(app, '/api/analyze', { method: 'POST', body: { caseId: 'duplicate-webhook' } });
  assert.equal(response.status, 200);
  assert.equal(response.data.validation.accepted, false);
  assert.equal(response.data.validation.execution, 'none');
  assert.equal(response.data.provenance.inference, 'injected-test-generator');
  assert.equal(response.data.result.amounts.completedMinor, '4900');
  assert.equal((await request(app, '/api/analyze', { method: 'POST', body: { caseId: 'duplicate-webhook', result: {} } })).status, 400);
});

test('inspection IDs are opaque, unique, time-limited and scoped to one server instance', async t => {
  const time = Date.now();
  const options = { env, clock: () => time, clientFactory: () => ({ getOrder: async () => envelope() }), generateFactory: () => async () => { throw new Error('Must not infer'); } };
  const app = await running(t, options);
  const first = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  const second = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  assert.match(first.data.resultId, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.data.resultId, second.data.resultId);
  assert.ok(!first.data.resultId.includes(inspect.orderId));
  assert.equal(first.data.resultExpiresAt, new Date(time + 5 * 60 * 1000).toISOString());
  const other = await running(t, options);
  const unknown = await request(other, '/api/analyze', { method: 'POST', body: { resultId: first.data.resultId } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error.code, 'INSPECTION_NOT_FOUND');
});

test('analyzing an inspection rereads its bound order, returns current reconciliation and excludes provider PII', async t => {
  let reads = 0;
  let generated;
  const app = await running(t, { env, clientFactory: () => ({ getOrder: async orderId => {
    assert.equal(orderId, inspect.orderId);
    reads++;
    const value = reads === 1 ? { ...fixtureCase('ready-to-capture').order, source: 'paypal-sandbox', status: 200, fetchedAt: new Date().toISOString() } : envelope();
    value.data.payer = { email_address: 'private-payer@example.invalid', name: { given_name: 'PRIVATE-BUYER' } };
    value.data.privateDetail = 'PRIVATE-PROVIDER-JSON';
    return value;
  } }), generateFactory: () => async ({ messages }) => {
    assert.ok(!JSON.stringify(messages).includes('PRIVATE-'));
    assert.ok(!JSON.stringify(messages).includes('private-payer'));
    assert.ok(!JSON.stringify(messages).includes(env.PAYPAL_CLIENT_SECRET));
    generated = JSON.parse(messages[1].content);
    return proposalFor(generated);
  } });
  const inspected = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  assert.equal(inspected.data.result.state, 'ready_to_capture');
  const response = await request(app, '/api/analyze', { method: 'POST', body: { resultId: inspected.data.resultId } });
  assert.equal(response.status, 200);
  assert.equal(reads, 2);
  assert.equal(response.data.result.state, 'paid');
  assert.equal(response.data.result.amounts.completedMinor, '4900');
  assert.deepEqual(response.data.result, generated);
  assert.equal(response.data.validation.accepted, true);
  assert.equal(response.data.resultId, inspected.data.resultId);
  assert.equal(response.data.resultExpiresAt, inspected.data.resultExpiresAt);
  assert.equal(response.data.provenance.kind, 'synthetic-fixture');
  assert.equal(response.data.provenance.inference, 'injected-test-generator');
  assert.match(response.data.provenance.notice, /Injected test adapter/);
  assert.ok(!JSON.stringify(response.data).includes('PRIVATE-'));
  assert.ok(!JSON.stringify(response.data).includes('private-payer'));
});

test('inspection analysis refuses client evidence, mixed selectors and unknown IDs before calling adapters', async t => {
  let calls = 0;
  const app = await running(t, { env, clientFactory: () => ({ getOrder: async () => { calls++; return envelope(); } }), generateFactory: () => async () => { calls++; return {}; } });
  const inspected = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  const resultId = inspected.data.resultId;
  const invalid = [
    {}, { caseId: 'duplicate-webhook', resultId }, { resultId, result: { state: 'paid' } },
    { resultId, expected: inspect }, { resultId, orderId: 'OTHER-ORDER' }, { resultId, source: 'paypal-sandbox' },
    { resultId, provenance: { kind: 'paypal-sandbox' } }, { resultId, events: [] },
    ...[null, [], 1, '../outside', 'x'.repeat(44)].map(value => ({ resultId: value }))
  ];
  for (const body of invalid) assert.equal((await request(app, '/api/analyze', { method: 'POST', body })).status, 400);
  const unknown = await request(app, '/api/analyze', { method: 'POST', body: { resultId: 'x'.repeat(43) } });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.error.code, 'INSPECTION_NOT_FOUND');
  assert.equal(calls, 1);
});

test('inspection TTL is absolute and expiry rejects analysis without refreshing or inferring', async t => {
  let time = Date.now();
  const start = time;
  let reads = 0;
  let inferences = 0;
  const app = await running(t, { env, clock: () => time, clientFactory: () => ({ getOrder: async () => {
    reads++; return { ...envelope(), fetchedAt: new Date(time).toISOString() };
  } }), generateFactory: () => async ({ messages }) => { inferences++; return proposalFor(JSON.parse(messages[1].content)); } });
  const inspected = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  time = start + 5 * 60 * 1000 - 1;
  const live = await request(app, '/api/analyze', { method: 'POST', body: { resultId: inspected.data.resultId } });
  assert.equal(live.status, 200);
  assert.equal(live.data.resultExpiresAt, inspected.data.resultExpiresAt);
  time++;
  const expired = await request(app, '/api/analyze', { method: 'POST', body: { resultId: inspected.data.resultId } });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.error.code, 'INSPECTION_EXPIRED');
  assert.equal(reads, 2);
  assert.equal(inferences, 1);
  assert.equal((await request(app, '/api/analyze', { method: 'POST', body: { resultId: inspected.data.resultId } })).status, 404);
});

test('inspection cache evicts the oldest context at its fixed capacity', async t => {
  const app = await running(t, { env, clientFactory: () => ({ getOrder: async () => envelope() }), generateFactory: () => async ({ messages }) => proposalFor(JSON.parse(messages[1].content)) });
  let first;
  let last;
  for (let index = 0; index < 129; index++) {
    const response = await request(app, '/api/inspect', { method: 'POST', body: inspect });
    assert.equal(response.status, 200);
    first ??= response.data.resultId;
    last = response.data.resultId;
  }
  assert.equal((await request(app, '/api/analyze', { method: 'POST', body: { resultId: first } })).status, 404);
  assert.equal((await request(app, '/api/analyze', { method: 'POST', body: { resultId: last } })).status, 200);
});

test('missing model configuration rejects inspection analysis without another PayPal read', async t => {
  let reads = 0;
  const app = await running(t, { env: { PAYPAL_CLIENT_ID: env.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: env.PAYPAL_CLIENT_SECRET }, clientFactory: () => ({ getOrder: async () => { reads++; return envelope(); } }), generateFactory: () => { throw new Error('Must not infer'); } });
  const inspected = await request(app, '/api/inspect', { method: 'POST', body: inspect });
  const response = await request(app, '/api/analyze', { method: 'POST', body: { resultId: inspected.data.resultId } });
  assert.equal(response.status, 503);
  assert.equal(response.data.error.code, 'AI_NOT_CONFIGURED');
  assert.equal(reads, 1);
});

test('a failed or invalid refresh cannot use the prior inspected result as a model fallback', async t => {
  for (const kind of ['failure', 'wrong-order', 'wrong-source']) {
    let reads = 0;
    let inferred = false;
    const app = await running(t, { env, clientFactory: () => ({ getOrder: async () => {
      if (++reads === 1) return envelope();
      if (kind === 'failure') throw new Error('PRIVATE-REFRESH-DETAIL');
      const value = envelope();
      if (kind === 'wrong-order') value.data.id = 'OTHER-ORDER';
      else value.source = 'production';
      return value;
    } }), generateFactory: () => async () => { inferred = true; return {}; } });
    const inspected = await request(app, '/api/inspect', { method: 'POST', body: inspect });
    const response = await request(app, '/api/analyze', { method: 'POST', body: { resultId: inspected.data.resultId } });
    assert.equal(response.status, 502);
    assert.equal(response.data.result, undefined);
    assert.equal(response.data.proposal, undefined);
    assert.ok(!JSON.stringify(response.data).includes('PRIVATE-'));
    assert.equal(inferred, false);
    assert.equal(reads, 2);
  }
});

test('model failure has no fabricated fallback and is sanitized', async t => {
  const app = await running(t, { env, generateFactory: () => async () => { throw new Error('PRIVATE-MODEL-DETAIL'); } });
  const response = await request(app, '/api/analyze', { method: 'POST', body: { caseId: 'duplicate-webhook' } });
  assert.equal(response.status, 502);
  assert.ok(!JSON.stringify(response.data).includes('PRIVATE-MODEL-DETAIL'));
  assert.equal(response.data.proposal, undefined);
});

test('security headers apply, CORS is absent and no arbitrary files or mutation routes are exposed', async t => {
  const app = await running(t);
  const response = await request(app, '/api/config');
  assert.match(response.headers['content-security-policy'], /script-src 'self'/);
  assert.ok(!response.headers['content-security-policy'].includes('unsafe-inline'));
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  for (const path of ['/server.mjs', '/.env', '/../.env', '/%2e%2e/.env', '/src/paypal.js', '/api/capture', '/api/config?secret=x']) assert.equal((await request(app, path)).status, 404);
  assert.equal((await request(app, '/api/config', { method: 'DELETE' })).status, 405);
});

test('client disconnect aborts an in-flight adapter operation without leaking an unhandled rejection', async t => {
  let started;
  let aborted;
  const hasStarted = new Promise(resolve => { started = resolve; });
  const hasAborted = new Promise(resolve => { aborted = resolve; });
  const app = await running(t, { env, clientFactory: ({ signal }) => ({ getOrder: () => {
    started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted(); reject(new Error('private abort')); }, { once: true }));
  } }) });
  const req = http.request({ hostname: '127.0.0.1', port: app.port, path: '/api/inspect', method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify(inspect));
  await hasStarted;
  req.destroy();
  await Promise.race([hasAborted, new Promise((_resolve, reject) => { const timer = setTimeout(() => reject(new Error('Cancellation was not propagated')), 1500); timer.unref(); })]);
});
