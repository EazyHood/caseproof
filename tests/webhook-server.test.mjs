import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'node:path';
import { createWebhookServer, parseWebhookArgs } from '../scripts/webhook-server.mjs';
import { createEvidenceStore } from '../src/evidence-store.js';
import { createPayPalSandboxClient } from '../src/paypal.js';

const ROOT = fileURLToPath(new URL('./', import.meta.url));
const PATH = `/webhooks/paypal/${'test-route-'.repeat(3)}`;
const TIME = '2026-10-02T12:00:00.000Z';
const env = { PAYPAL_CLIENT_ID: 'injected-client', PAYPAL_CLIENT_SECRET: 'injected-secret', PAYPAL_WEBHOOK_ID: 'injected-webhook' };
const headers = {
  'Content-Type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA',
  'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/INJECTED',
  'paypal-transmission-id': 'injected-transmission', 'paypal-transmission-sig': 'injected-signature',
  'paypal-transmission-time': TIME
};
const event = (changes = {}) => ({ id: 'WH-INJECTED-001', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: TIME, resource: { id: 'CAPTURE-ONE', status: 'COMPLETED', amount: { value: '49.00', currency_code: 'USD' }, supplementary_data: { related_ids: { order_id: 'ORDER-ONE' } } }, ...changes });
const envelope = body => ({ event: structuredClone(body), source: 'paypal-sandbox', receivedAt: TIME, verification: { status: 'SUCCESS', method: 'paypal-postback', checkedAt: TIME } });
const fakeClient = () => ({ environment: 'sandbox', verifyWebhook: async ({ event: body }) => envelope(body) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function makeStore(t, cases = [{ id: 'one', order: 'ORDER-ONE', capture: 'CAPTURE-ONE', source: 'synthetic-fixture' }]) {
  const directory = await mkdtemp(resolve(ROOT, '.webhook-test-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(`${resolve(ROOT)}${sep}`));
    await rm(directory, { recursive: true, force: true });
  });
  const store = await createEvidenceStore({ directory, clock: () => Date.parse(TIME) + 10000 });
  for (const item of cases) {
    await store.createCase({ caseId: item.id, source: item.source ?? 'synthetic-fixture', expected: { orderId: item.order, invoiceId: `invoice-${item.id}`, value: '49.00', currencyCode: 'USD' } });
    await store.saveSnapshot(item.id, { source: item.source ?? 'synthetic-fixture', status: 200, fetchedAt: TIME, data: { id: item.order, status: 'COMPLETED', purchase_units: [{ invoice_id: `invoice-${item.id}`, amount: { value: '49.00', currency_code: 'USD' }, payments: { captures: item.capture ? [{ id: item.capture, status: 'COMPLETED', amount: { value: '49.00', currency_code: 'USD' } }] : [] } }] } });
  }
  return store;
}

async function running(t, options = {}) {
  const store = options.store ?? await makeStore(t);
  const server = createWebhookServer({ store, caseIds: ['one'], env, routePath: PATH, clientFactory: fakeClient, ...options });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  return { server, store, port: server.address().port };
}

function request(app, { body = event(), raw, path = PATH, method = 'POST', overrideHeaders = {} } = {}) {
  return new Promise((resolveResponse, reject) => {
    const selectedHeaders = { ...headers, ...overrideHeaders };
    for (const key of Object.keys(selectedHeaders)) if (selectedHeaders[key] === undefined) delete selectedHeaders[key];
    const req = http.request({ hostname: '127.0.0.1', port: app.port, path, method, headers: selectedHeaders, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolveResponse({ status: res.statusCode, headers: res.headers, text, data: text ? JSON.parse(text) : null }); });
    });
    req.on('error', reject);
    req.end(raw ?? JSON.stringify(body));
  });
}

test('CLI defaults to help and cannot start without explicit run, cases or with secret arguments', () => {
  assert.deepEqual(parseWebhookArgs([]), { help: true });
  assert.deepEqual(parseWebhookArgs(['--help']), { help: true });
  assert.deepEqual(parseWebhookArgs(['--run', '--case', 'one', '--case', 'two']), { run: true, caseIds: ['one', 'two'] });
  for (const args of [['--case', 'one'], ['--run'], ['--run', '--case', 'one', '--client-secret', 'x'], ['--run', '--run', '--case', 'one']]) assert.throws(() => parseWebhookArgs(args));
});

test('factory has random paths, bounded trusted configuration and does not listen', () => {
  const store = { readCase() {}, saveVerifiedWebhook() {} };
  const one = createWebhookServer({ store, caseIds: ['one'] });
  const two = createWebhookServer({ store, caseIds: ['one'] });
  assert.notEqual(one.webhookPath, two.webhookPath);
  assert.equal(one.listening, false);
  for (const change of [{ caseIds: ['../one'] }, { caseIds: ['one', 'one'] }, { caseIds: ['nul'] }, { routePath: '/webhook' }, { allowedHostnames: ['*.example.com'] }, { maxInFlight: 5 }]) assert.throws(() => createWebhookServer({ store, caseIds: ['one'], ...change }));
});

test('verified original JSON is stored once; a fresh signature check is required for each duplicate', async t => {
  const seen = [];
  const app = await running(t, { clientFactory: () => ({ environment: 'sandbox', verifyWebhook: async value => { seen.push(structuredClone(value)); return envelope(value.event); } }) });
  const body = event({ summary: 'Unicode preserved: cobro €', extra: { nested: ['original', 1] } });
  assert.equal((await request(app, { body })).status, 200);
  assert.equal((await request(app, { body })).status, 200);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[0].event, body);
  assert.deepEqual(Object.keys(seen[0].headers).sort(), Object.keys(headers).filter(key => key !== 'Content-Type').sort());
  const state = await app.store.readCase('one');
  assert.equal(state.events.length, 1);
  assert.deepEqual(state.events[0].event, body);
  assert.equal(state.events[0].receivedAt, TIME);
  assert.equal(state.events[0].verification.checkedAt, TIME);
  assert.equal(state.events[0].source, 'synthetic-fixture');
  assert.equal(state.events[0].verification.method, 'fixture-assertion-not-cryptographic');
});

test('failed verification cannot read cases or save evidence; JSON verification labels cannot bypass it', async t => {
  let reads = 0, writes = 0;
  const app = await running(t, { store: { readCase() { reads++; }, saveVerifiedWebhook() { writes++; } }, clientFactory: () => ({ environment: 'sandbox', verifyWebhook: async ({ event: body }) => ({ ...envelope(body), verification: { status: 'FAILURE' } }) }) });
  const response = await request(app, { body: event({ source: 'paypal-sandbox', verification: { status: 'SUCCESS' } }) });
  assert.equal(response.status, 401);
  assert.equal(reads, 0); assert.equal(writes, 0);
});

test('no configured credentials, changed verified JSON and invalid adapter fail closed', async t => {
  let calls = 0;
  const empty = await running(t, { env: {}, clientFactory: () => { calls++; return fakeClient(); } });
  assert.equal((await request(empty)).status, 503); assert.equal(calls, 0);
  const changed = await running(t, { clientFactory: () => ({ environment: 'sandbox', verifyWebhook: async ({ event: body }) => { body.resource.id = 'CHANGED'; return envelope(body); } }) });
  assert.equal((await request(changed)).data.error.code, 'INVALID_VERIFIED_EVENT');
  assert.equal((await changed.store.readCase('one')).events.length, 0);
  const production = await running(t, { clientFactory: () => ({ ...fakeClient(), environment: 'production' }) });
  assert.equal((await request(production)).data.error.code, 'INVALID_ADAPTER');
});

test('only exact path, POST and explicit local or tunnel hosts are accepted; no browser or status surface', async t => {
  const app = await running(t, { allowedHostnames: ['hooks.example.com'] });
  for (const path of ['/', '/.env', '/api/config', `${PATH}?x=1`, PATH.replace('webhooks', '%77ebhooks'), `http://127.0.0.1:${app.port}${PATH}`]) assert.equal((await request(app, { path })).status, 404);
  assert.equal((await request(app, { method: 'GET' })).status, 405);
  assert.equal((await request(app, { overrideHeaders: { Host: 'attacker.example.com' } })).status, 403);
  assert.equal((await request(app, { overrideHeaders: { Host: '127.0.0.1:80' } })).status, 403);
  assert.equal((await request(app, { overrideHeaders: { Origin: `http://127.0.0.1:${app.port}` } })).status, 403);
  assert.equal((await request(app, { overrideHeaders: { 'sec-fetch-site': 'same-origin' } })).status, 403);
  const response = await request(app, { overrideHeaders: { Host: 'hooks.example.com:443' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('missing, repeated and oversized signature headers are rejected before adapter use', async t => {
  let calls = 0;
  const app = await running(t, { clientFactory: () => { calls++; return fakeClient(); } });
  for (const value of [undefined, ['one', 'two'], 'x'.repeat(1001)]) assert.equal((await request(app, { overrideHeaders: { 'paypal-transmission-sig': value } })).status, 400);
  assert.equal(calls, 0);
});

test('body encoding, size, duplicate keys, invalid UTF-8, nesting and nonfinite JSON fail before verification', async t => {
  let calls = 0;
  const app = await running(t, { clientFactory: () => { calls++; return fakeClient(); } });
  for (const raw of ['[]', 'null', '{}', '{bad}', '{"id":"a","id":"b"}', '{"a":1,"\\u0061":2}', '{"a":1e400}', '{"a":' + '['.repeat(33) + '0' + ']'.repeat(33) + '}', Buffer.from([0xff, 0xfe])]) assert.equal((await request(app, { raw })).status, 400);
  assert.equal((await request(app, { overrideHeaders: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await request(app, { overrideHeaders: { 'Content-Encoding': 'gzip' } })).status, 415);
  assert.equal((await request(app, { overrideHeaders: { 'Content-Length': String(65 * 1024) }, raw: '' })).status, 413);
  assert.equal((await request(app, { raw: 'x'.repeat(65 * 1024), overrideHeaders: { 'Transfer-Encoding': 'chunked' } })).status, 413);
  assert.equal(calls, 0);
});

test('unknown verified events are acknowledged without retention, and explicit wrong order cannot fall back to capture', async t => {
  const app = await running(t);
  for (const resource of [{ id: 'UNKNOWN' }, { id: 'CAPTURE-ONE', supplementary_data: { related_ids: { order_id: 'OTHER-ORDER' } } }]) {
    const response = await request(app, { body: event({ resource }) });
    assert.equal(response.status, 200); assert.deepEqual(response.data, { received: true });
  }
  assert.equal((await app.store.readCase('one')).events.length, 0);
});

test('known capture and refund up link associate without trusting incoming invoice or case ID', async t => {
  const app = await running(t);
  assert.equal((await request(app, { body: event({ resource: { id: 'CAPTURE-ONE' } }) })).status, 200);
  const refund = event({ id: 'WH-REFUND', event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: { id: 'REFUND-ONE', links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/CAPTURE-ONE' }] } });
  assert.equal((await request(app, { body: refund })).status, 200);
  assert.equal((await app.store.readCase('one')).events.length, 2);
});

test('checkout order events associate by resource ID', async t => {
  const app = await running(t);
  assert.equal((await request(app, { body: event({ event_type: 'CHECKOUT.ORDER.APPROVED', resource: { id: 'ORDER-ONE', status: 'APPROVED' } }) })).status, 200);
  assert.equal((await app.store.readCase('one')).events.length, 1);
});

test('malformed explicit order references cannot fall back to a known capture', async t => {
  const app = await running(t);
  for (const order_id of ['', null, 0, false]) {
    const response = await request(app, { body: event({ resource: { id: 'CAPTURE-ONE', supplementary_data: { related_ids: { order_id } } } }) });
    assert.equal(response.status, 503);
    assert.equal(response.data.error.code, 'INVALID_EVENT_REFERENCE');
  }
  assert.equal((await app.store.readCase('one')).events.length, 0);
});

test('order and capture ownership pointing at different selected cases is ambiguous', async t => {
  const store = await makeStore(t, [{ id: 'one', order: 'ORDER-ONE', capture: 'CAPTURE-ONE' }, { id: 'two', order: 'ORDER-TWO', capture: 'CAPTURE-TWO' }]);
  const app = await running(t, { store, caseIds: ['one', 'two'] });
  const response = await request(app, { body: event({ resource: { id: 'CAPTURE-TWO', supplementary_data: { related_ids: { order_id: 'ORDER-ONE' } } } }) });
  assert.equal(response.status, 503);
  assert.equal(response.data.error.code, 'AMBIGUOUS_CASE');
  assert.equal((await store.readCase('one')).events.length, 0);
  assert.equal((await store.readCase('two')).events.length, 0);
});

test('ambiguous associations, unreadable cases and storage errors never acknowledge success', async t => {
  const store = await makeStore(t, [{ id: 'one', order: 'ORDER-ONE' }, { id: 'two', order: 'ORDER-ONE' }]);
  const ambiguous = await running(t, { store, caseIds: ['one', 'two'] });
  assert.equal((await request(ambiguous)).data.error.code, 'AMBIGUOUS_CASE');
  const unreadable = await running(t, { store: { readCase: async () => { throw new Error('PRIVATE-FILE-LOCATION'); }, saveVerifiedWebhook() {} } });
  const response = await request(unreadable);
  assert.equal(response.status, 503); assert.ok(!response.text.includes('PRIVATE'));
  const diskError = await running(t, { store: { readCase: store.readCase, saveVerifiedWebhook: async () => { throw new Error('PRIVATE-DISK-DETAIL'); } } });
  assert.equal((await request(diskError)).status, 503);
});

test('injected clients cannot write a sandbox case even with a PayPal-looking envelope', async t => {
  const store = await makeStore(t, [{ id: 'one', order: 'ORDER-ONE', source: 'paypal-sandbox' }]);
  const app = await running(t, { store });
  assert.equal((await request(app)).data.error.code, 'CASE_SOURCE_MISMATCH');
  assert.equal((await store.readCase('one')).events.length, 0);
});

test('success waits for durable save and concurrent load is bounded', async t => {
  const gate = deferred(), saving = deferred();
  const store = await makeStore(t);
  const app = await running(t, { maxInFlight: 1, store: { readCase: store.readCase, saveVerifiedWebhook: async (...args) => { saving.resolve(); await gate.promise; return store.saveVerifiedWebhook(...args); } } });
  let finished = false;
  const response = request(app).then(value => { finished = true; return value; });
  await saving.promise;
  assert.equal(finished, false);
  const busy = await request(app);
  assert.equal(busy.status, 503); assert.equal(busy.data.error.code, 'RECEIVER_BUSY');
  gate.resolve();
  assert.equal((await response).status, 200);
  assert.equal((await store.readCase('one')).events.length, 1);
});

test('same event ID with changed verified contents is rejected without replacing evidence', async t => {
  const app = await running(t);
  await request(app);
  assert.equal((await request(app, { body: event({ summary: 'Changed later' }) })).status, 503);
  const state = await app.store.readCase('one');
  assert.equal(state.events.length, 1); assert.equal(state.events[0].event.summary, undefined);
});

test('operation timeout aborts verification and prevents a late response from saving', async t => {
  let aborted = false;
  const late = deferred();
  const app = await running(t, { operationTimeoutMs: 40, clientFactory: ({ signal }) => {
    signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    return { environment: 'sandbox', verifyWebhook: async ({ event: body }) => { await late.promise; return envelope(body); } };
  } });
  assert.equal((await request(app)).status, 503); assert.equal(aborted, true);
  late.resolve(); await new Promise(done => setImmediate(done));
  assert.equal((await app.store.readCase('one')).events.length, 0);
});

test('timeout during disk append sends no success; a completed append remains deduplicable', async t => {
  const gate = deferred(), saving = deferred(), saved = deferred();
  const store = await makeStore(t);
  const app = await running(t, { operationTimeoutMs: 50, store: { readCase: store.readCase, saveVerifiedWebhook: async (...args) => { saving.resolve(); await gate.promise; const result = await store.saveVerifiedWebhook(...args); saved.resolve(); return result; } } });
  const pending = request(app); await saving.promise;
  assert.equal((await pending).status, 503);
  gate.resolve(); await saved.promise;
  assert.equal((await store.readCase('one')).events.length, 1);
  assert.equal((await request(app)).status, 200);
  assert.equal((await store.readCase('one')).events.length, 1);
});

test('disconnect aborts in-flight verification without accepting late evidence', async t => {
  const started = deferred(), aborted = deferred();
  const app = await running(t, { clientFactory: ({ signal }) => ({ environment: 'sandbox', verifyWebhook: () => {
    started.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(new Error('PRIVATE-CANCEL')); }, { once: true }));
  } }) });
  const req = http.request({ hostname: '127.0.0.1', port: app.port, path: PATH, method: 'POST', headers, agent: false });
  req.on('error', () => {}); req.end(JSON.stringify(event()));
  await started.promise; req.destroy(); await aborted.promise;
  assert.equal((await app.store.readCase('one')).events.length, 0);
});

test('slow request body is bounded independently of upstream processing', async t => {
  const app = await running(t, { bodyTimeoutMs: 30 });
  const req = http.request({ hostname: '127.0.0.1', port: app.port, path: PATH, method: 'POST', headers: { ...headers, 'Content-Length': 500 }, agent: false });
  req.on('error', () => {}); req.write('{');
  const [res] = await once(req, 'response');
  assert.equal(res.statusCode, 408); res.resume(); await once(res, 'end'); req.destroy();
});

test('real adapter protocol can be exercised with injected transport, and still has fixture provenance', async t => {
  const calls = [];
  const app = await running(t, { clientFactory: config => createPayPalSandboxClient({ ...config, now: () => Date.parse(TIME), fetchImpl: async (url, options) => {
    calls.push({ url, body: options.body });
    return new Response(JSON.stringify(url.endsWith('/token') ? { access_token: 'INJECTED-NOT-A-REAL-TOKEN', expires_in: 300 } : { verification_status: 'SUCCESS' }), { status: 200 });
  } }) });
  const response = await request(app);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
  const posted = JSON.parse(calls[1].body);
  assert.equal(posted.webhook_id, env.PAYPAL_WEBHOOK_ID);
  assert.deepEqual(posted.webhook_event, event());
  assert.equal((await app.store.readCase('one')).events[0].source, 'synthetic-fixture');
  assert.ok(!response.text.includes('TOKEN'));
});
