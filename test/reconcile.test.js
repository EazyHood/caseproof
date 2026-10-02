import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCase, toMinor, fromMinor } from '../src/index.js';
import { fixtureCase } from '../fixtures/cases.js';

const capture = input => input.order.data.purchase_units[0].payments.captures[0];
const codes = result => result.issues.map(x => x.code);

test('decimal calculations stay exact, including amounts beyond floating-point precision', () => {
  assert.equal(toMinor('0.10', 'USD') + toMinor('0.20', 'USD'), 30n);
  assert.equal(toMinor('9999999999999.99', 'USD'), 999999999999999n);
  assert.equal(fromMinor(-1n, 'USD'), '-0.01');
  for (const value of ['1.001', '-1', '1e3', 'NaN', 49, '01.00']) assert.throws(() => toMinor(value, 'USD'));
  assert.throws(() => toMinor('100', 'JPY'), /Unsupported currency/);
});

test('a duplicated webhook never duplicates the captured amount or mutates the input', () => {
  const input = fixtureCase();
  const before = structuredClone(input);
  const result = reconcileCase(input);
  assert.equal(result.state, 'paid');
  assert.equal(result.amounts.completedMinor, '4900');
  assert.equal(result.duplicateEvents, 1);
  assert.equal(result.mode, 'fixture');
  assert.deepEqual(result.allowedActions, ['record_payment']);
  assert.deepEqual(input, before);
});

test('a repeated capture ID is counted once, but a conflicting value blocks decisions', () => {
  const input = fixtureCase('paid');
  input.order.data.purchase_units[0].payments.captures.push(structuredClone(capture(input)));
  assert.equal(reconcileCase(input).amounts.completedMinor, '4900');
  input.order.data.purchase_units[0].payments.captures[1].amount.value = '50.00';
  const result = reconcileCase(input);
  assert.equal(result.state, 'review_required');
  assert.ok(codes(result).includes('CAPTURE_CONFLICT'));
});

test('two distinct completed captures add exactly and detect overpayment', () => {
  const input = fixtureCase('paid');
  input.order.data.purchase_units[0].payments.captures.push({ ...structuredClone(capture(input)), id: 'ANOTHER-CAPTURE' });
  const result = reconcileCase(input);
  assert.equal(result.state, 'overpaid');
  assert.equal(result.amounts.completedMinor, '9800');
  assert.equal(result.amounts.difference, '-49.00');
  assert.deepEqual(result.allowedActions, ['manual_review']);
});

test('approval is not payment; capture is a proposal and never executes', () => {
  const result = reconcileCase(fixtureCase('ready-to-capture'));
  assert.equal(result.state, 'ready_to_capture');
  assert.equal(result.amounts.completedMinor, '0');
  assert.deepEqual(result.allowedActions, ['capture_order']);
  assert.equal(result.execution, 'proposal-only');
});

test('pending, underpaid and stale evidence cannot authorize marking paid or retrying capture', () => {
  for (const [name, expected] of [['pending-capture', 'pending'], ['amount-mismatch', 'underpaid'], ['stale-snapshot', 'review_required']]) {
    const result = reconcileCase(fixtureCase(name));
    assert.equal(result.state, expected);
    assert.ok(!result.allowedActions.includes('record_payment'));
    assert.ok(!result.allowedActions.includes('capture_order'));
  }
});

test('an additional pending capture blocks marking paid despite a complete captured total', () => {
  const input = fixtureCase('paid');
  input.order.data.purchase_units[0].payments.captures.push({ ...structuredClone(capture(input)), id: 'EXTRA-PENDING', status: 'PENDING' });
  assert.equal(reconcileCase(input).state, 'pending');
});

test('COMPLETED order without capture evidence is not paid', () => {
  const input = fixtureCase('paid');
  delete input.order.data.purchase_units[0].payments;
  const result = reconcileCase(input);
  assert.equal(result.state, 'review_required');
  assert.ok(codes(result).includes('COMPLETED_WITHOUT_CAPTURE'));
});

test('unknown or malformed evidence fails closed', () => {
  const mutations = [
    input => { input.order.data.id = 'OTHER-ORDER'; },
    input => { input.order.data.purchase_units[0].invoice_id = 'OTHER-INVOICE'; },
    input => { capture(input).amount.currency_code = 'EUR'; },
    input => { capture(input).amount.value = '49.001'; },
    input => { capture(input).status = 'NEW_STATUS'; },
    input => { input.order.source = 'browser-says-trusted'; },
    input => { input.order.data.intent = 'AUTHORIZE'; },
    input => { input.order.data.purchase_units.push(structuredClone(input.order.data.purchase_units[0])); },
    input => { input.order.data.purchase_units[0].amount.value = '50.00'; }
  ];
  for (const mutate of mutations) {
    const input = fixtureCase('paid'); mutate(input);
    assert.equal(reconcileCase(input).state, 'review_required');
  }
});

test('refund states do not assert net proceeds or a settled invoice', () => {
  for (const status of ['REFUNDED', 'PARTIALLY_REFUNDED']) {
    const input = fixtureCase('paid'); capture(input).status = status;
    const result = reconcileCase(input);
    assert.equal(result.state, 'review_required');
    assert.equal(result.amounts.completedMinor, '0');
    assert.ok(codes(result).includes('REFUND_REVIEW'));
  }
});

test('unverified completed event cannot make an approved order paid', () => {
  const result = reconcileCase(fixtureCase('unverified-webhook'));
  assert.equal(result.state, 'ready_to_capture');
  assert.equal(result.amounts.completedMinor, '0');
  assert.ok(codes(result).includes('EVENT_UNVERIFIED'));
});

test('an invalid signature cannot suppress a valid event sharing the same ID', () => {
  const input = fixtureCase();
  input.events[0].verification.status = 'FAILURE';
  input.events[1].event.create_time = '2026-10-02T05:00:15Z';
  const result = reconcileCase(input);
  assert.equal(result.state, 'review_required');
  assert.ok(codes(result).includes('EVENT_NEWER_THAN_SNAPSHOT'));
});

test('conflicting duplicate event contents block reconciliation, object key order does not', () => {
  const input = fixtureCase();
  input.events[1].event.resource.amount.value = '50.00';
  assert.ok(codes(reconcileCase(input)).includes('EVENT_CONFLICT'));
  const equivalent = fixtureCase();
  const { id, ...rest } = equivalent.events[1].event;
  equivalent.events[1].event = { ...rest, id };
  assert.equal(reconcileCase(equivalent).state, 'paid');
});

test('old pending event cannot regress a fresh completed capture', () => {
  const input = fixtureCase();
  input.events = [input.events[0]];
  input.events[0].event.event_type = 'PAYMENT.CAPTURE.PENDING';
  input.events[0].event.resource.status = 'PENDING';
  assert.equal(reconcileCase(input).state, 'paid');
});

test('a newer verified event and a missing verified capture require refresh', () => {
  const newer = fixtureCase();
  newer.events[0].event.create_time = '2026-10-02T05:00:15Z';
  newer.events = [newer.events[0]];
  assert.ok(codes(reconcileCase(newer)).includes('EVENT_NEWER_THAN_SNAPSHOT'));
  const missing = fixtureCase();
  missing.events = [missing.events[0]];
  missing.events[0].event.resource.id = 'MISSING-CAPTURE';
  assert.ok(codes(reconcileCase(missing)).includes('CAPTURE_NOT_IN_SNAPSHOT'));
});

test('unrelated verified event does not alter the invoice and synthetic/sandbox mixing is blocked', () => {
  const unrelated = fixtureCase();
  unrelated.events = [unrelated.events[0]];
  unrelated.events[0].event.resource.supplementary_data.related_ids.order_id = 'SOME-OTHER-ORDER';
  assert.equal(reconcileCase(unrelated).state, 'paid');
  const mixed = fixtureCase(); mixed.events[0].source = 'paypal-sandbox';
  assert.ok(codes(reconcileCase(mixed)).includes('MIXED_PROVENANCE'));
});

test('missing snapshot, unsupported expected currency, and invalid comparison time are explicit', () => {
  const input = fixtureCase(); input.order = null; input.events = [];
  assert.equal(reconcileCase(input).state, 'unknown');
  input.expected.currencyCode = 'JPY';
  assert.throws(() => reconcileCase(input), /Unsupported currency/);
  const invalid = fixtureCase(); invalid.observedAt = 'no-date';
  assert.throws(() => reconcileCase(invalid), /observedAt/);
});

test('refund with its own ID is linked through capture_id or PayPal up link and blocks paid', () => {
  for (const relation of [
    { supplementary_data: { related_ids: { capture_id: 'FIXTURE-CAPTURE-001' } } },
    { links: [{ rel: 'up', href: 'https://api.sandbox.paypal.com/v2/payments/captures/FIXTURE-CAPTURE-001' }] }
  ]) {
    for (const time of ['2026-10-02T05:00:00Z', '2026-10-02T05:00:15Z']) {
      const input = fixtureCase('paid');
      input.events = [{ source: 'synthetic-fixture', verification: { status: 'SUCCESS' }, event: { id: 'REFUND-EVENT', event_type: 'PAYMENT.CAPTURE.REFUNDED', create_time: time, resource: { id: 'REFUND-001', amount: { value: '5.00', currency_code: 'USD' }, ...relation } } }];
      const result = reconcileCase(input);
      assert.equal(result.state, 'review_required');
      assert.ok(!result.allowedActions.includes('record_payment'));
      assert.ok(!codes(result).includes('EVENT_UNLINKED'));
    }
  }
});

test('snapshot refund records and malformed refund collections block payment confirmation', () => {
  for (const refunds of [[{ id: 'REFUND-1', status: 'COMPLETED', amount: { value: '5.00', currency_code: 'USD' } }], {}]) {
    const input = fixtureCase('paid');
    input.order.data.purchase_units[0].payments.refunds = refunds;
    const result = reconcileCase(input);
    assert.equal(result.state, 'review_required');
    assert.ok(!result.allowedActions.includes('record_payment'));
  }
});

test('equivalent decimal formatting in verified capture events is reconciled numerically', () => {
  const input = fixtureCase();
  input.events = [input.events[0]];
  input.events[0].event.resource.amount.value = '49';
  assert.equal(reconcileCase(input).state, 'paid');
});
