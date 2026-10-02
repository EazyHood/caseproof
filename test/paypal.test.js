import test from 'node:test';
import assert from 'node:assert/strict';
import { createPayPalSandboxClient, PAYPAL_SANDBOX_ORIGIN, PayPalError } from '../src/index.js';

// Transport stubs only: these tests make zero calls to PayPal.
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const auth = () => json({ access_token: 'stub-access-token', expires_in: 3600 });
function transport(responses) {
  const calls = [];
  return { calls, fetchImpl: async (url, options) => { calls.push({ url, ...options }); const next = responses.shift(); if (next instanceof Error) throw next; if (!next) throw new Error('Unexpected stub call'); return next; } };
}
const options = { clientId: 'stub-client', clientSecret: 'stub-secret', now: () => Date.parse('2026-10-02T05:00:10Z') };

test('client refuses production and resource path injection before making requests', () => {
  assert.throws(() => createPayPalSandboxClient({ ...options, baseUrl: 'https://api-m.paypal.com' }), /sandbox/);
  const client = createPayPalSandboxClient(options);
  assert.throws(() => client.getOrder('../payments'), /resource ID/);
  assert.throws(() => client.captureOrder('ORDER', {}), /requestId/);
});

test('OAuth is server-side, cached and shared by concurrent reads', async () => {
  const stub = transport([auth(), json({ id: 'ORDER' }), json({ id: 'CAPTURE' })]);
  const client = createPayPalSandboxClient({ ...options, ...stub });
  const results = await Promise.all([client.getOrder('ORDER'), client.getCapture('CAPTURE')]);
  assert.equal(stub.calls.length, 3);
  assert.equal(stub.calls.filter(x => x.url.endsWith('/token')).length, 1);
  assert.equal(stub.calls[0].body, 'grant_type=client_credentials');
  assert.equal(stub.calls[1].headers.Authorization, 'Bearer stub-access-token');
  assert.ok(stub.calls.every(x => x.url.startsWith(PAYPAL_SANDBOX_ORIGIN) && x.redirect === 'error'));
  assert.equal(results[0].source, 'paypal-sandbox');
  assert.equal(results[0].fetchedAt, '2026-10-02T05:00:10.000Z');
});

test('create and capture use distinct explicit idempotency keys and full representations', async () => {
  const stub = transport([auth(), json({ id: 'ORDER' }, 201), json({ id: 'ORDER', status: 'COMPLETED' }, 201)]);
  const client = createPayPalSandboxClient({ ...options, ...stub });
  await client.createOrder({ invoiceId: 'CP-1042', value: '49.00', requestId: 'create-unique-1' });
  await client.captureOrder('ORDER', { requestId: 'capture-unique-1' });
  assert.equal(stub.calls[1].headers['PayPal-Request-Id'], 'create-unique-1');
  assert.equal(stub.calls[2].headers['PayPal-Request-Id'], 'capture-unique-1');
  assert.equal(stub.calls[2].headers.Prefer, 'return=representation');
  assert.equal(stub.calls[2].body, '{}');
  assert.deepEqual(JSON.parse(stub.calls[1].body), { intent: 'CAPTURE', purchase_units: [{ invoice_id: 'CP-1042', amount: { currency_code: 'USD', value: '49.00' } }] });
  await assert.rejects(client.createOrder({ invoiceId: 'CP-1042', value: '50.00', requestId: 'create-unique-1' }), /different operation or payload/);
});

test('capture timeout has unknown outcome, is never silently retried, permits exact explicit retry', async () => {
  const stub = transport([auth(), new Error('secret-bearing-network-error'), json({ id: 'ORDER' })]);
  const client = createPayPalSandboxClient({ ...options, ...stub });
  await assert.rejects(client.captureOrder('ORDER', { requestId: 'capture-1' }), error => error instanceof PayPalError && error.outcome === 'unknown' && !error.message.includes('secret-bearing'));
  assert.equal(stub.calls.length, 2);
  await client.captureOrder('ORDER', { requestId: 'capture-1' });
  assert.equal(stub.calls.length, 3);
  assert.equal(stub.calls[2].headers['PayPal-Request-Id'], 'capture-1');
});

test('API failures expose only bounded code/debug metadata, not arbitrary error bodies', async () => {
  const stub = transport([auth(), json({ name: 'UNPROCESSABLE_ENTITY', message: 'stub-secret', details: [{ description: 'private data' }], debug_id: 'debug-123' }, 422)]);
  const client = createPayPalSandboxClient({ ...options, ...stub });
  await assert.rejects(client.captureOrder('ORDER', { requestId: 'capture-1' }), error => {
    assert.equal(error.code, 'UNPROCESSABLE_ENTITY'); assert.equal(error.debugId, 'debug-123');
    assert.equal(error.outcome, 'unknown'); assert.ok(!JSON.stringify(error).includes('stub-secret'));
    return true;
  });
});

test('a 401 invalidates the token but does not silently replay the request', async () => {
  const stub = transport([auth(), json({ name: 'AUTHENTICATION_FAILURE' }, 401), auth(), json({ id: 'ORDER' })]);
  const client = createPayPalSandboxClient({ ...options, ...stub });
  await assert.rejects(client.getOrder('ORDER'), /AUTHENTICATION_FAILURE/);
  assert.equal(stub.calls.length, 2);
  await client.getOrder('ORDER');
  assert.equal(stub.calls.length, 4);
});

const webhookHeaders = {
  'PayPal-Auth-Algo': 'SHA256withRSA', 'PayPal-Cert-Url': 'https://api.sandbox.paypal.com/v1/notifications/certs/STUB',
  'PayPal-Transmission-Id': 'stub-transmission', 'PayPal-Transmission-Sig': 'stub-signature', 'PayPal-Transmission-Time': '2026-10-02T05:00:00Z'
};

test('webhook verification binds configured ID and complete event, exact SUCCESS only', async () => {
  const stub = transport([auth(), json({ verification_status: 'SUCCESS' }), json({ verification_status: 'UNKNOWN' })]);
  const client = createPayPalSandboxClient({ ...options, ...stub, webhookId: 'CONFIGURED-WEBHOOK' });
  const event = { id: 'EVENT-1', webhook_id: 'ATTACKER-INPUT', event_type: 'PAYMENT.CAPTURE.COMPLETED' };
  const verified = await client.verifyWebhook({ headers: webhookHeaders, event });
  assert.equal(verified.verification.status, 'SUCCESS');
  const body = JSON.parse(stub.calls[1].body);
  assert.equal(body.webhook_id, 'CONFIGURED-WEBHOOK');
  assert.deepEqual(body.webhook_event, event);
  assert.equal(body.transmission_id, 'stub-transmission');
  assert.equal((await client.verifyWebhook({ headers: webhookHeaders, event })).verification.status, 'FAILURE');
});

test('missing webhook headers are rejected without fetching or accepting an event', async () => {
  const stub = transport([]);
  const client = createPayPalSandboxClient({ ...options, ...stub, webhookId: 'CONFIGURED' });
  await assert.rejects(client.verifyWebhook({ headers: {}, event: { id: 'EVENT' } }), /paypal-auth-algo/);
  assert.equal(stub.calls.length, 0);
});

test('webhook verification binds the exact submitted event despite mutation during await', async () => {
  let release;
  let submitted;
  const waiting = new Promise(resolve => { release = resolve; });
  const client = createPayPalSandboxClient({ ...options, webhookId: 'CONFIGURED', fetchImpl: async (url, request) => {
    if (url.endsWith('/token')) return auth();
    submitted = JSON.parse(request.body).webhook_event;
    await waiting;
    return json({ verification_status: 'SUCCESS' });
  } });
  const event = { id: 'SIGNED-EVENT', resource: { id: 'SIGNED-CAPTURE' } };
  const promise = client.verifyWebhook({ headers: webhookHeaders, event });
  event.id = 'UNSIGNED-EVENT';
  event.resource.id = 'UNSIGNED-CAPTURE';
  release();
  const verified = await promise;
  assert.deepEqual(verified.event, submitted);
  assert.equal(verified.event.id, 'SIGNED-EVENT');
  assert.equal(verified.event.resource.id, 'SIGNED-CAPTURE');
  assert.throws(() => { verified.event.id = 'MUTATED-AFTER'; }, TypeError);
  assert.throws(() => { verified.verification.status = 'FAILURE'; }, TypeError);
});
