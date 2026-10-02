import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceStore } from '../src/evidence-store.js';
import { createSandboxWorkflow } from '../src/sandbox-workflow.js';
import { parseSandboxArgs } from '../scripts/sandbox.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const env = { PAYPAL_CLIENT_ID: 'fake-client', PAYPAL_CLIENT_SECRET: 'never-print-this-secret' };
const input = { caseId: 'workflow-case', invoiceId: 'CP-1042', value: '49.00', currencyCode: 'USD' };
const code = expected => error => error.code === expected;
async function setup(t, behavior = {}) {
  const directory = await mkdtemp(join(root, '.sandbox-workflow-test-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(`${resolve(root)}${sep}.sandbox-workflow-test-`)); await rm(directory, { recursive: true, force: true }); });
  let time = Date.parse('2026-10-02T06:00:00Z');
  const clock = () => time += 100;
  const store = await createEvidenceStore({ directory, clock });
  const calls = [];
  let order = { id: 'TEST-ORDER', intent: 'CAPTURE', status: 'CREATED', payer: { email_address: 'PRIVATE-PAYER-EMAIL' }, links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=PRIVATE-APPROVAL-TOKEN' }], purchase_units: [{ invoice_id: input.invoiceId, amount: { value: input.value, currency_code: input.currencyCode } }] };
  const response = (status = 200) => ({ data: structuredClone(order), status, source: 'paypal-sandbox', fetchedAt: new Date(clock()).toISOString() });
  const client = {
    environment: 'sandbox',
    async createOrder(payload) { calls.push({ method: 'createOrder', payload }); assert.ok((await store.readCase(input.caseId)).requests.some(item => item.requestId === payload.requestId)); if (behavior.create) return behavior.create(payload, response); return response(201); },
    async getOrder(id) { calls.push({ method: 'getOrder', id }); if (behavior.read) return behavior.read(id, response); return response(); },
    async captureOrder(id, options) {
      calls.push({ method: 'captureOrder', id, options });
      assert.ok((await store.readCase(input.caseId)).requests.some(item => item.requestId === options.requestId));
      if (behavior.capture) return behavior.capture(id, options, response);
      order.status = 'COMPLETED'; order.purchase_units[0].payments = { captures: [{ id: 'TEST-CAPTURE', status: 'COMPLETED', amount: { value: '49.00', currency_code: 'USD' } }] };
      return response(201);
    }
  };
  const makeWorkflow = () => createSandboxWorkflow({ store, env, clientFactory: () => client, clock });
  return { store, directory, calls, workflow: makeWorkflow(), makeWorkflow, response, approve: () => { order.status = 'APPROVED'; }, setOrder: value => { order = value; }, getOrder: () => order, advance: ms => { time += ms; } };
}

test('CLI help is inert and mutation commands require explicit flags without credential arguments', () => {
  assert.deepEqual(parseSandboxArgs([]), { help: true });
  assert.deepEqual(parseSandboxArgs(['--help']), { help: true });
  assert.throws(() => parseSandboxArgs(['create', '--case', 'case', '--invoice', 'invoice', '--value', '49']), /--run/);
  assert.throws(() => parseSandboxArgs(['capture', '--case', 'case', '--run']), /confirm-capture/);
  assert.throws(() => parseSandboxArgs(['capture', '--case', 'case', '--run', '--confirm-capture', '--client-secret', 'secret']));
  assert.equal(parseSandboxArgs(['capture', '--case', 'case', '--run', '--confirm-capture']).command, 'capture');
});

test('create reserves before network, saves and reads the order, and repeat create reuses the bound order', async t => {
  const context = await setup(t);
  const created = await context.workflow.create(input);
  assert.deepEqual(context.calls.map(item => item.method), ['createOrder', 'getOrder']);
  assert.equal(created.disposition, 'created-and-read');
  assert.equal(created.orderId, 'TEST-ORDER');
  assert.equal(created.approvalLinkAvailable, true);
  assert.equal(created.provenance.kind, 'synthetic-fixture');
  assert.equal(created.result.state, 'awaiting_approval');
  await context.makeWorkflow().create(input);
  assert.equal(context.calls.filter(item => item.method === 'createOrder').length, 1);
  assert.equal((await context.store.readCase(input.caseId)).requests.length, 1);
});

test('missing credentials cannot trigger provider calls or reserve a payment key', async t => {
  const context = await setup(t);
  const workflow = createSandboxWorkflow({ store: context.store });
  await assert.rejects(workflow.create(input), code('SANDBOX_NOT_CONFIGURED'));
  await assert.rejects(context.store.readCase(input.caseId), code('CASE_NOT_FOUND'));
  assert.equal(context.calls.length, 0);
});

test('unknown create requires explicit retry and preserves the same durable request ID after restart', async t => {
  let attempt = 0;
  const context = await setup(t, { create: (_payload, response) => { if (attempt++ === 0) throw new Error('private upstream secret'); return response(201); } });
  await assert.rejects(context.workflow.create(input), error => error.code === 'PAYPAL_CREATE_UNKNOWN' && error.outcome === 'unknown' && !error.message.includes('private'));
  const key = (await context.store.readCase(input.caseId)).requests[0].requestId;
  await assert.rejects(context.makeWorkflow().create(input), code('CREATE_RETRY_REQUIRED'));
  assert.equal(context.calls.filter(item => item.method === 'createOrder').length, 1);
  await context.makeWorkflow().create({ ...input, retryCreate: true });
  const attemptedKeys = context.calls.filter(item => item.method === 'createOrder').map(item => item.payload.requestId);
  assert.deepEqual(attemptedKeys, [key, key]);
});

test('old uncertain keys are not retried indefinitely or replaced', async t => {
  const context = await setup(t, { create: () => { throw new Error('timeout'); } });
  await assert.rejects(context.workflow.create(input), code('PAYPAL_CREATE_UNKNOWN'));
  context.advance(16 * 60 * 1000);
  await assert.rejects(context.workflow.create({ ...input, retryCreate: true }), code('RETRY_WINDOW_EXPIRED'));
  assert.equal(context.calls.length, 1);
  assert.equal((await context.store.readCase(input.caseId)).requests.length, 1);
});

test('capture requires explicit decision then performs fresh read before capture and a follow-up read', async t => {
  const context = await setup(t);
  await context.workflow.create(input);
  const before = context.calls.length;
  await assert.rejects(context.workflow.capture(input.caseId), code('CAPTURE_CONFIRMATION_REQUIRED'));
  assert.equal(context.calls.length, before);
  context.approve();
  const result = await context.workflow.capture(input.caseId, { confirmCapture: true });
  assert.deepEqual(context.calls.slice(before).map(item => item.method), ['getOrder', 'captureOrder', 'getOrder']);
  assert.equal(result.result.state, 'paid');
  const read = await context.store.readCase(input.caseId);
  assert.notEqual(read.requests.find(item => item.operation === 'create_order').requestId, read.requests.find(item => item.operation === 'capture_order').requestId);
});

test('already-paid, pending, mismatched and unapproved orders never trigger capture', async t => {
  const context = await setup(t);
  await context.workflow.create(input);
  const result = await context.workflow.capture(input.caseId, { confirmCapture: true });
  assert.equal(result.disposition, 'capture-not-sent');
  context.approve();
  await context.workflow.capture(input.caseId, { confirmCapture: true });
  for (const status of ['COMPLETED', 'PENDING']) {
    context.getOrder().purchase_units[0].payments.captures[0].status = status;
    assert.equal((await context.workflow.capture(input.caseId, { confirmCapture: true })).disposition, 'capture-not-sent');
  }
  assert.equal(context.calls.filter(item => item.method === 'captureOrder').length, 1);
});

test('an approved order whose invoice amount disagrees is held for review before any capture', async t => {
  const context = await setup(t);
  await context.workflow.create(input); context.approve();
  context.getOrder().purchase_units[0].amount.value = '59.00';
  const result = await context.workflow.capture(input.caseId, { confirmCapture: true });
  assert.equal(result.disposition, 'capture-not-sent');
  assert.equal(result.result.state, 'review_required');
  assert.equal(context.calls.filter(item => item.method === 'captureOrder').length, 0);
});

test('capture timeout is reconciled before retry and the same capture UUID is reused', async t => {
  let attempt = 0;
  const context = await setup(t, { capture: (_id, _options, response) => { if (attempt++ === 0) throw new Error('timeout'); const current = context.getOrder(); current.status = 'COMPLETED'; current.purchase_units[0].payments = { captures: [{ id: 'TEST-CAPTURE', status: 'COMPLETED', amount: { value: '49.00', currency_code: 'USD' } }] }; return response(201); } });
  await context.workflow.create(input); context.approve();
  await assert.rejects(context.workflow.capture(input.caseId, { confirmCapture: true }), code('PAYPAL_CAPTURE_UNKNOWN'));
  const afterFailure = context.calls.length;
  const result = await context.makeWorkflow().capture(input.caseId, { confirmCapture: true });
  assert.equal(context.calls[afterFailure].method, 'getOrder');
  const keys = context.calls.filter(item => item.method === 'captureOrder').map(item => item.options.requestId);
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(result.result.state, 'paid');
});

test('a timed-out capture that actually completed is discovered by the next read and never replayed', async t => {
  const context = await setup(t, { capture: () => { const current = context.getOrder(); current.status = 'COMPLETED'; current.purchase_units[0].payments = { captures: [{ id: 'TEST-CAPTURE', status: 'COMPLETED', amount: { value: '49.00', currency_code: 'USD' } }] }; throw new Error('timeout after execution'); } });
  await context.workflow.create(input); context.approve();
  await assert.rejects(context.workflow.capture(input.caseId, { confirmCapture: true }), code('PAYPAL_CAPTURE_UNKNOWN'));
  const recovered = await context.makeWorkflow().capture(input.caseId, { confirmCapture: true });
  assert.equal(recovered.result.state, 'paid');
  assert.equal(recovered.disposition, 'capture-not-sent');
  assert.equal(context.calls.filter(item => item.method === 'captureOrder').length, 1);
});

test('post-capture read failure reports uncertain workflow outcome, never not-attempted', async t => {
  let failReads = false;
  const context = await setup(t, { read: (_id, response) => { if (failReads) throw new Error('read failed'); return response(); }, capture: (_id, _options, response) => { const current = context.getOrder(); current.status = 'COMPLETED'; current.purchase_units[0].payments = { captures: [{ id: 'TEST-CAPTURE', status: 'COMPLETED', amount: { value: '49.00', currency_code: 'USD' } }] }; failReads = true; return response(201); } });
  await context.workflow.create(input); context.approve();
  await assert.rejects(context.workflow.capture(input.caseId, { confirmCapture: true }), error => error.code === 'POST_CAPTURE_READ_FAILED' && error.outcome === 'unknown');
  assert.equal((await context.workflow.reconcile(input.caseId)).result.state, 'paid');
});

test('stdout projections and offline exports omit payer data, approval tokens and credentials', async t => {
  const context = await setup(t);
  const created = await context.workflow.create(input);
  const before = context.calls.length;
  const exported = await context.workflow.exportCase(input.caseId);
  const reconciled = await context.workflow.reconcile(input.caseId);
  assert.equal(context.calls.length, before);
  const publicText = JSON.stringify([created, exported, reconciled]);
  for (const secret of ['PRIVATE-PAYER-EMAIL', 'PRIVATE-APPROVAL-TOKEN', env.PAYPAL_CLIENT_SECRET]) assert.ok(!publicText.includes(secret));
  assert.ok((await readFile(join(context.directory, `${input.caseId}.jsonl`), 'utf8')).includes('PRIVATE-PAYER-EMAIL'));
  assert.equal(exported.provenance.kind, 'synthetic-fixture');
});

test('production or malformed clients and mismatched provider order responses are rejected', async t => {
  const context = await setup(t);
  const production = createSandboxWorkflow({ store: context.store, env, clientFactory: () => ({ environment: 'production' }) });
  await assert.rejects(production.create(input), code('INVALID_CLIENT'));
  await context.workflow.create(input);
  context.getOrder().id = 'DIFFERENT-ORDER';
  await assert.rejects(context.workflow.read(input.caseId), code('INVALID_PROVIDER_RESPONSE'));
});

test('case and request records alone are never labeled as received PayPal evidence', async t => {
  const context = await setup(t);
  await context.store.createCase({ caseId: input.caseId, expected: { invoiceId: input.invoiceId, value: input.value, currencyCode: input.currencyCode }, source: 'paypal-sandbox' });
  await context.store.reserveRequest(input.caseId, { operation: 'create_order', payload: { invoiceId: input.invoiceId, value: input.value, currencyCode: input.currencyCode } });
  const offline = createSandboxWorkflow({ store: context.store });
  for (const result of [await offline.reconcile(input.caseId), await offline.exportCase(input.caseId)]) {
    assert.equal(result.provenance.kind, 'no-provider-evidence');
    assert.equal(result.provenance.configuredSource, 'paypal-sandbox');
    assert.equal(result.result, null);
    assert.match(result.provenance.notice, /No provider response/);
  }
  assert.equal(context.calls.length, 0);
});
