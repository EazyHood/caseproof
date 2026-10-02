import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, writeFile, link, stat, open } from 'node:fs/promises';
import { resolve, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceStore } from '../src/evidence-store.js';
import { fixtureCase } from '../fixtures/cases.js';
import { reconcileCase } from '../src/reconcile.js';

const testsRoot = dirname(fileURLToPath(import.meta.url));
const fixedTime = Date.parse('2026-10-02T06:00:00Z');
const expected = fixtureCase('paid').expected;
const requestPayload = { invoiceId: expected.invoiceId, value: expected.value, currencyCode: expected.currencyCode };
const rejectsCode = code => error => error.code === code;
async function setup(t, options = {}) {
  const directory = await mkdtemp(join(testsRoot, '.evidence-store-test-'));
  t.after(async () => {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${resolve(testsRoot)}${sep}.evidence-store-test-`));
    await rm(target, { recursive: true, force: true });
  });
  const store = await createEvidenceStore({ directory, clock: () => fixedTime, ...options });
  return { store, directory };
}
async function ready(t, { source = 'synthetic-fixture', ...options } = {}) {
  const context = await setup(t, options);
  await context.store.createCase({ caseId: 'invoice-1042', expected, source });
  return context;
}
function snapshot(source = 'synthetic-fixture') { return { ...fixtureCase('paid').order, status: 200, source }; }
function event(source = 'synthetic-fixture') {
  const item = fixtureCase().events[0];
  return { ...item, source, receivedAt: '2026-10-02T05:00:11Z', verification: { status: 'SUCCESS', method: source === 'paypal-sandbox' ? 'paypal-postback' : 'fixture-assertion-not-cryptographic', checkedAt: '2026-10-02T05:00:11Z' } };
}

test('case creation is persistent, immutable and idempotent across store instances', async t => {
  const { store, directory } = await ready(t);
  const second = await createEvidenceStore({ directory, clock: () => fixedTime });
  assert.deepEqual((await second.readCase('invoice-1042')).expected, expected);
  await store.createCase({ caseId: 'invoice-1042', expected, source: 'synthetic-fixture' });
  assert.equal((await store.readCase('invoice-1042')).records.length, 1);
  await assert.rejects(store.createCase({ caseId: 'invoice-1042', expected: { ...expected, invoiceId: 'changed' }, source: 'synthetic-fixture' }), rejectsCode('CASE_CONFLICT'));
  await assert.rejects(store.createCase({ caseId: 'invoice-1042', expected, source: 'paypal-sandbox' }), rejectsCode('CASE_CONFLICT'));
});

test('path traversal, Windows device names and case aliases never create case files', async t => {
  const { store } = await setup(t);
  for (const caseId of ['../outside', 'x/y', 'x\\y', 'CON', 'con', 'lpt1', 'Invoice-1042', '.', 'x.jsonl', 'a:stream', 'x'.repeat(65)]) {
    await assert.rejects(store.createCase({ caseId, expected, source: 'synthetic-fixture' }), rejectsCode('INVALID_CASE_ID'));
  }
});

test('request keys are durable, generated once and tied to the exact operation payload', async t => {
  const { store, directory } = await ready(t);
  const first = await store.reserveRequest('invoice-1042', { operation: 'create_order', payload: requestPayload });
  assert.match(first.requestId, /^[0-9a-f-]{36}$/);
  const second = await createEvidenceStore({ directory, clock: () => fixedTime });
  const retry = await second.reserveRequest('invoice-1042', { operation: 'create_order', payload: requestPayload });
  assert.equal(retry.duplicate, true);
  assert.equal(retry.requestId, first.requestId);
  await assert.rejects(store.reserveRequest('invoice-1042', { operation: 'create_order', payload: { ...requestPayload, value: '49' } }), rejectsCode('IDEMPOTENCY_CONFLICT'));
  const capture = await store.reserveRequest('invoice-1042', { operation: 'capture_order', payload: { orderId: expected.orderId } });
  assert.notEqual(capture.requestId, first.requestId);
  assert.equal((await store.readCase('invoice-1042')).requests.length, 2);
});

test('concurrent store instances cannot reserve two keys or lose append records', async t => {
  const { store, directory } = await ready(t);
  const second = await createEvidenceStore({ directory, clock: () => fixedTime });
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) => (index % 2 ? store : second).reserveRequest('invoice-1042', { operation: 'create_order', payload: requestPayload })));
  assert.equal(new Set(results.map(item => item.requestId)).size, 1);
  assert.equal(results.filter(item => !item.duplicate).length, 1);
  assert.equal((await store.readCase('invoice-1042')).records.length, 2);
});

test('a complete append followed by failed sync cannot become a successful duplicate until sync succeeds', async t => {
  const probeContext = await setup(t);
  const probe = await open(join(probeContext.directory, 'sync-probe'), 'w');
  const prototype = Object.getPrototypeOf(probe);
  const originalSync = prototype.sync;
  await probe.close();
  let failSync = false;
  let attempts = 0;
  t.mock.method(prototype, 'sync', async function () {
    attempts++;
    if (failSync) throw Object.assign(new Error('Injected sync failure'), { code: 'EIO' });
    return originalSync.call(this);
  });

  for (const operation of ['create', 'reserve', 'snapshot', 'webhook']) {
    const { store, directory } = await setup(t);
    const create = () => store.createCase({ caseId: 'invoice-1042', expected, source: 'synthetic-fixture' });
    if (operation !== 'create') await create();
    const invoke = operation === 'create' ? create
      : operation === 'reserve' ? () => store.reserveRequest('invoice-1042', { operation: 'create_order', payload: requestPayload })
      : operation === 'snapshot' ? () => store.saveSnapshot('invoice-1042', snapshot())
      : () => store.saveVerifiedWebhook('invoice-1042', event());
    const beforeAttempts = attempts;
    const file = join(directory, 'invoice-1042.jsonl');
    failSync = true;
    await assert.rejects(invoke(), rejectsCode('EIO'), `${operation}: the initial sync failure must propagate`);
    const afterAppend = await readFile(file, 'utf8');
    await assert.rejects(invoke(), rejectsCode('EIO'), `${operation}: a failed duplicate sync must also propagate`);
    assert.equal(attempts - beforeAttempts, 2, `${operation}: retry must sync again`);
    assert.equal(await readFile(file, 'utf8'), afterAppend, `${operation}: retry must not append another record`);
    failSync = false;
    const result = await invoke();
    assert.equal(attempts - beforeAttempts, 3, `${operation}: success requires a completed sync`);
    if (operation !== 'create') assert.equal(result.duplicate, true);
    const state = await store.readCase('invoice-1042');
    assert.equal(state.records.length, operation === 'create' ? 1 : 2);
    if (operation === 'reserve') assert.equal(result.requestId, state.requests[0].requestId);
    assert.equal(await readFile(file, 'utf8'), afterAppend);
  }
});

test('snapshot preserves observed time, stores its own timestamp and returns the newest observation', async t => {
  const { store } = await ready(t);
  const newest = snapshot(); newest.fetchedAt = '2026-10-02T05:30:00Z';
  const saved = await store.saveSnapshot('invoice-1042', newest);
  assert.equal(saved.fetchedAt, newest.fetchedAt);
  assert.equal(saved.recordedAt, '2026-10-02T06:00:00.000Z');
  await store.saveSnapshot('invoice-1042', snapshot());
  const read = await store.readCase('invoice-1042');
  assert.equal(read.latestSnapshot.fetchedAt, newest.fetchedAt);
  assert.equal(read.snapshots.length, 2);
  const input = { expected, order: read.latestSnapshot, observedAt: '2026-10-02T06:00:00Z' };
  assert.equal(reconcileCase(input).state, 'review_required'); // Reading cannot make an old observation fresh.
});

test('first snapshot binds the order and subsequent snapshots cannot rebind it', async t => {
  const { store } = await setup(t);
  const { orderId, ...withoutOrder } = expected;
  await store.createCase({ caseId: 'invoice-1042', expected: withoutOrder, source: 'synthetic-fixture' });
  await assert.rejects(store.reserveRequest('invoice-1042', { operation: 'capture_order', payload: { orderId } }), rejectsCode('REQUEST_MISMATCH'));
  await store.saveSnapshot('invoice-1042', snapshot());
  assert.equal((await store.readCase('invoice-1042')).expected.orderId, orderId);
  const different = snapshot(); different.data.id = 'DIFFERENT-ORDER'; different.fetchedAt = '2026-10-02T05:10:00Z';
  await assert.rejects(store.saveSnapshot('invoice-1042', different), rejectsCode('ORDER_CONFLICT'));
});

test('same snapshot cannot change payload; capture identity cannot change across observations', async t => {
  const { store } = await ready(t);
  const original = snapshot();
  await store.saveSnapshot('invoice-1042', original);
  assert.equal((await store.saveSnapshot('invoice-1042', original)).duplicate, true);
  const conflict = snapshot(); conflict.data.status = 'APPROVED';
  await assert.rejects(store.saveSnapshot('invoice-1042', conflict), rejectsCode('SNAPSHOT_CONFLICT'));
  const changedAmount = snapshot(); changedAmount.fetchedAt = '2026-10-02T05:10:00Z'; changedAmount.data.purchase_units[0].payments.captures[0].amount.value = '48.00';
  await assert.rejects(store.saveSnapshot('invoice-1042', changedAmount), rejectsCode('CAPTURE_CONFLICT'));
  const laterStatus = snapshot(); laterStatus.fetchedAt = '2026-10-02T05:20:00Z'; laterStatus.data.purchase_units[0].payments.captures[0].status = 'REFUNDED';
  await store.saveSnapshot('invoice-1042', laterStatus);
  const read = await store.readCase('invoice-1042');
  assert.equal(read.snapshots[0].data.purchase_units[0].payments.captures[0].status, 'COMPLETED');
  assert.equal(read.snapshots[1].data.purchase_units[0].payments.captures[0].status, 'REFUNDED');
});

test('equivalent timestamp formats identify one observation and cannot hide conflicting snapshots', async t => {
  const { store, directory } = await ready(t);
  const original = snapshot(); original.fetchedAt = '2026-10-02T05:00:00Z';
  const first = await store.saveSnapshot('invoice-1042', original);
  const before = await readFile(join(directory, 'invoice-1042.jsonl'), 'utf8');
  for (const fetchedAt of ['2026-10-02T05:00:00.000Z', '2026-10-02T00:00:00-05:00']) {
    const alias = { ...snapshot(), fetchedAt };
    const duplicate = await store.saveSnapshot('invoice-1042', alias);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.recordHash, first.recordHash);
    assert.equal(duplicate.fetchedAt, original.fetchedAt);
    alias.data.status = 'APPROVED';
    await assert.rejects(store.saveSnapshot('invoice-1042', alias), rejectsCode('SNAPSHOT_CONFLICT'));
  }
  const state = await store.readCase('invoice-1042');
  assert.equal(state.snapshots.length, 1);
  assert.equal(state.latestSnapshot.data.status, original.data.status);
  assert.equal(await readFile(join(directory, 'invoice-1042.jsonl'), 'utf8'), before);
});

test('equivalent decimal capture amounts do not conflict and original snapshot JSON is preserved', async t => {
  const { store } = await ready(t);
  await store.saveSnapshot('invoice-1042', snapshot());
  const later = snapshot(); later.fetchedAt = '2026-10-02T05:10:00Z';
  later.data.purchase_units[0].payments.captures[0].amount.value = '49';
  await store.saveSnapshot('invoice-1042', later);
  const state = await store.readCase('invoice-1042');
  assert.equal(state.snapshots[0].data.purchase_units[0].payments.captures[0].amount.value, '49.00');
  assert.equal(state.snapshots[1].data.purchase_units[0].payments.captures[0].amount.value, '49');
  const changed = snapshot(); changed.fetchedAt = '2026-10-02T05:20:00Z';
  changed.data.purchase_units[0].payments.captures[0].amount.value = '49.01';
  await assert.rejects(store.saveSnapshot('invoice-1042', changed), rejectsCode('CAPTURE_CONFLICT'));
  changed.data.purchase_units[0].payments.captures[0].amount = { value: '49.00', currency_code: 'EUR' };
  await assert.rejects(store.saveSnapshot('invoice-1042', changed), rejectsCode('CAPTURE_CONFLICT'));
});

test('invalid source and future snapshot timestamps cannot produce stored evidence', async t => {
  const { store } = await ready(t);
  for (const item of [{ ...snapshot(), source: 'paypal-sandbox' }, { ...snapshot(), fetchedAt: '2030-01-01T00:00:00Z' }, { ...snapshot(), status: 500 }]) {
    await assert.rejects(store.saveSnapshot('invoice-1042', item), rejectsCode('INVALID_SNAPSHOT'));
  }
  assert.equal((await store.readCase('invoice-1042')).snapshots.length, 0);
});

test('verified event JSON survives restart exactly and duplicate storage does not rewrite it', async t => {
  const { store, directory } = await ready(t, { source: 'paypal-sandbox' });
  const input = event('paypal-sandbox');
  const saved = await store.saveVerifiedWebhook('invoice-1042', input);
  const expectedEvent = structuredClone(input.event);
  input.event.resource.amount.value = '999.00';
  const second = await createEvidenceStore({ directory, clock: () => fixedTime });
  const read = await second.readCase('invoice-1042');
  assert.deepEqual(read.events[0].event, expectedEvent);
  assert.ok(Object.isFrozen(read.events[0].event.resource.amount));
  const before = await readFile(join(directory, 'invoice-1042.jsonl'), 'utf8');
  const retry = event('paypal-sandbox'); retry.receivedAt = '2026-10-02T05:00:15Z'; retry.verification.checkedAt = retry.receivedAt;
  const duplicate = await second.saveVerifiedWebhook('invoice-1042', retry);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.recordHash, saved.recordHash);
  assert.equal(await readFile(join(directory, 'invoice-1042.jsonl'), 'utf8'), before);
  await assert.rejects(store.saveVerifiedWebhook('invoice-1042', input), rejectsCode('EVENT_CONFLICT'));
});

test('failed verification, fixture provenance and unrelated events cannot enter a sandbox case', async t => {
  const { store } = await ready(t, { source: 'paypal-sandbox' });
  const failed = event('paypal-sandbox'); failed.verification.status = 'FAILURE';
  await assert.rejects(store.saveVerifiedWebhook('invoice-1042', failed), rejectsCode('UNVERIFIED_WEBHOOK'));
  await assert.rejects(store.saveVerifiedWebhook('invoice-1042', event()), rejectsCode('UNVERIFIED_WEBHOOK'));
  const unrelated = event('paypal-sandbox'); unrelated.event.resource.supplementary_data.related_ids.order_id = 'OTHER-ORDER';
  await assert.rejects(store.saveVerifiedWebhook('invoice-1042', unrelated), rejectsCode('WEBHOOK_UNLINKED'));
  assert.equal((await store.readCase('invoice-1042')).events.length, 0);
});

test('refund events can link through a saved capture without using their own refund ID as capture ID', async t => {
  const { store } = await ready(t);
  await store.saveSnapshot('invoice-1042', snapshot());
  const refund = event();
  refund.event = { id: 'REFUND-EVENT', event_type: 'PAYMENT.CAPTURE.REFUNDED', create_time: '2026-10-02T05:00:00Z', resource: { id: 'REFUND-ID', links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/FIXTURE-CAPTURE-001' }] } };
  await store.saveVerifiedWebhook('invoice-1042', refund);
  assert.equal((await store.readCase('invoice-1042')).events.length, 1);
});

test('replay preserves origin, verification and original time and never writes new evidence', async t => {
  const { store, directory } = await ready(t);
  await store.saveSnapshot('invoice-1042', snapshot());
  const saved = await store.saveVerifiedWebhook('invoice-1042', event());
  const bytes = (await stat(join(directory, 'invoice-1042.jsonl'))).size;
  const replay = await store.replayEvents('invoice-1042', { copies: 2 });
  assert.equal(replay.provenance.kind, 'stored-replay');
  assert.equal(replay.provenance.source, 'synthetic-fixture');
  assert.equal(replay.events.length, 2);
  assert.equal(replay.events[0].receivedAt, saved.receivedAt);
  assert.equal(replay.events[0].source, 'synthetic-fixture');
  assert.equal(replay.events[0].replay.originalRecordHash, saved.recordHash);
  const result = reconcileCase({ ...fixtureCase('paid'), events: replay.events });
  assert.equal(result.duplicateEvents, 1);
  assert.equal(result.amounts.completedMinor, '4900');
  assert.equal((await stat(join(directory, 'invoice-1042.jsonl'))).size, bytes);
});

test('known secret fields and credential patterns are rejected without redacting signed JSON', async t => {
  const { store, directory } = await ready(t);
  for (const secret of [{ client_secret: 'never-store-me' }, { headers: { authorization: 'Bearer never-store-me' } }, { note: 'Bearer never-store-me' }, { note: 'https://host/?access_token=never-store-me' }]) {
    const input = event(); Object.assign(input.event.resource, secret);
    await assert.rejects(store.saveVerifiedWebhook('invoice-1042', input), rejectsCode('SECRET_REJECTED'));
  }
  assert.ok(!(await readFile(join(directory, 'invoice-1042.jsonl'), 'utf8')).includes('never-store-me'));
});

test('non-JSON array properties and accessors are rejected without invoking or changing them', async t => {
  const { store } = await ready(t);
  let invoked = 0;
  const accessor = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get() { invoked++; return 'derived'; } });
  const overridden = ['value'];
  overridden.map = () => { invoked++; return ['changed']; };
  const sparse = new Array(1);
  for (const value of [accessor, overridden, sparse]) {
    const input = event(); input.event.resource.testArray = value;
    await assert.rejects(store.saveVerifiedWebhook('invoice-1042', input), rejectsCode('INVALID_JSON'));
  }
  assert.equal(invoked, 0);
  assert.equal((await store.readCase('invoice-1042')).records.length, 1);
  const input = event(); input.event.resource.testArray = [null, true, { ordinary: ['value'] }];
  const saved = await store.saveVerifiedWebhook('invoice-1042', input);
  assert.deepEqual(saved.event.resource.testArray, input.event.resource.testArray);
});

test('malformed envelope roots return validation errors without creating evidence', async t => {
  const { store } = await ready(t);
  for (const input of [null, true, 1, 'text', []]) {
    await assert.rejects(store.saveSnapshot('invoice-1042', input), rejectsCode('INVALID_SNAPSHOT'));
    await assert.rejects(store.saveVerifiedWebhook('invoice-1042', input), rejectsCode('INVALID_WEBHOOK'));
  }
  assert.equal((await store.readCase('invoice-1042')).records.length, 1);
});

test('truncated or changed JSONL fails closed instead of discarding evidence or appending', async t => {
  const { store, directory } = await ready(t);
  const file = join(directory, 'invoice-1042.jsonl');
  const original = await readFile(file, 'utf8');
  await appendFile(file, '{"incomplete":');
  await assert.rejects(store.readCase('invoice-1042'), rejectsCode('CORRUPT_STORE'));
  await assert.rejects(store.reserveRequest('invoice-1042', { operation: 'create_order', payload: requestPayload }), rejectsCode('CORRUPT_STORE'));
  await writeFile(file, original.replace('CP-1042', 'CP-9999'));
  await assert.rejects(store.readCase('invoice-1042'), rejectsCode('CORRUPT_STORE'));
});

test('external lock and hard-linked case files are refused without changing either file', async t => {
  const { store, directory } = await ready(t);
  const lock = join(directory, 'invoice-1042.lock');
  await writeFile(lock, 'external-process');
  await assert.rejects(store.readCase('invoice-1042'), rejectsCode('STORE_BUSY'));
  assert.equal(await readFile(lock, 'utf8'), 'external-process');
  await rm(lock);
  await link(join(directory, 'invoice-1042.jsonl'), join(directory, 'hardlink.jsonl'));
  await assert.rejects(store.readCase('invoice-1042'), rejectsCode('UNSAFE_PATH'));
});

test('oversized event input is rejected before appending a record', async t => {
  const { store } = await ready(t);
  const input = event(); input.event.description = 'x'.repeat(128 * 1024);
  await assert.rejects(store.saveVerifiedWebhook('invoice-1042', input), rejectsCode('RECORD_TOO_LARGE'));
  assert.equal((await store.readCase('invoice-1042')).records.length, 1);
});
