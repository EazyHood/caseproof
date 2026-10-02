import { toMinor, fromMinor } from './money.js';

const SOURCES = new Set(['paypal-sandbox', 'synthetic-fixture']);
const CAPTURE_STATES = new Set(['COMPLETED', 'PENDING', 'DECLINED', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED']);
const ORDER_STATES = new Set(['CREATED', 'SAVED', 'APPROVED', 'VOIDED', 'COMPLETED', 'PAYER_ACTION_REQUIRED']);
const epoch = value => typeof value === 'string' ? Date.parse(value) : NaN;
const captureFromUpLink = resource => {
  if (!Array.isArray(resource?.links)) return null;
  for (const link of resource.links) {
    if (link?.rel !== 'up' || typeof link.href !== 'string') continue;
    try {
      const url = new URL(link.href);
      if (!['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'].includes(url.hostname) || url.protocol !== 'https:') continue;
      const match = url.pathname.match(/^\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/);
      if (match) return match[1];
    } catch { /* Malformed links are not used as evidence relationships. */ }
  }
  return null;
};
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Pure, server-side reconciliation. Snapshot provenance must be assigned by trusted code. */
export function reconcileCase({ expected, order = null, events = [], observedAt, maxSnapshotAgeMs = 300000 }) {
  if (!expected?.orderId || !expected?.invoiceId) throw new TypeError('Expected orderId and invoiceId are required.');
  const expectedMinor = toMinor(expected.value, expected.currencyCode);
  if (expectedMinor <= 0n) throw new TypeError('Expected value must be positive.');
  const now = epoch(observedAt);
  if (!Number.isFinite(now) || !Number.isFinite(maxSnapshotAgeMs) || maxSnapshotAgeMs <= 0) throw new TypeError('Valid observedAt and positive maxSnapshotAgeMs are required.');
  if (!Array.isArray(events)) throw new TypeError('Events must be an array.');
  const issues = [];
  const evidence = [{ id: 'expected', kind: 'merchant-record', label: 'Expected invoice', facts: { ...expected, minor: String(expectedMinor) } }];
  const issue = (code, message, severity = 'blocking', evidenceIds = []) => issues.push({ code, message, severity, evidenceIds });
  let completedMinor = 0n;
  let pending = false;
  let refunded = false;
  let duplicateEvents = 0;
  const captures = new Map();
  const data = order?.data;
  const snapshotAt = epoch(order?.fetchedAt);
  if (!data) issue('SNAPSHOT_MISSING', 'Fetch the order from PayPal sandbox before deciding.');
  else {
    evidence.push({ id: `order:${data.id}`, kind: 'order', label: 'Order snapshot', facts: { id: data.id, status: data.status, intent: data.intent, fetchedAt: order.fetchedAt, source: order.source } });
    if (!SOURCES.has(order.source)) issue('PROVENANCE_UNKNOWN', 'Order provenance is missing or unsupported.');
    if (!Number.isFinite(snapshotAt) || snapshotAt > now || now - snapshotAt > maxSnapshotAgeMs) issue('SNAPSHOT_STALE', 'Refresh the order snapshot before deciding.');
    if (data.id !== expected.orderId) issue('ORDER_MISMATCH', 'The snapshot belongs to another order.');
    if (data.intent !== 'CAPTURE') issue('INTENT_UNSUPPORTED', 'Only CAPTURE-intent orders are supported.');
    if (!ORDER_STATES.has(data.status)) issue('ORDER_STATUS_UNKNOWN', 'Unknown order status requires review.');
    if (!Array.isArray(data.purchase_units) || data.purchase_units.length !== 1) issue('PURCHASE_UNITS_UNSUPPORTED', 'This spike requires exactly one purchase unit.');
    else {
      const unit = data.purchase_units[0];
      if (unit.invoice_id !== expected.invoiceId) issue('INVOICE_MISMATCH', 'PayPal invoice ID does not match the merchant record.');
      if (unit.amount?.currency_code !== expected.currencyCode) issue('ORDER_CURRENCY_MISMATCH', 'Order currency does not match the merchant record.');
      try {
        if (toMinor(unit.amount?.value, unit.amount?.currency_code) !== expectedMinor) issue('ORDER_AMOUNT_MISMATCH', 'Order amount does not match the merchant record.');
      } catch { issue('ORDER_AMOUNT_INVALID', 'Order amount cannot be interpreted safely.'); }
      if (unit.payments?.refunds !== undefined) {
        if (!Array.isArray(unit.payments.refunds)) issue('REFUNDS_INVALID', 'Refund collection is malformed.');
        else if (unit.payments.refunds.length) {
          refunded = true;
          for (const [index, refund] of unit.payments.refunds.entries()) {
            evidence.push({ id: `refund:${refund?.id ?? `unidentified-${index}`}`, kind: 'refund', label: 'Refund in order snapshot', facts: { id: refund?.id, status: refund?.status, amount: refund?.amount } });
          }
        }
      }
      const list = unit.payments?.captures ?? [];
      if (!Array.isArray(list)) issue('CAPTURES_INVALID', 'Capture collection is malformed.');
      else for (const capture of list) {
        if (!capture?.id || typeof capture.id !== 'string') { issue('CAPTURE_ID_MISSING', 'A capture has no stable ID.'); continue; }
        const key = `capture:${capture.id}`;
        if (captures.has(capture.id)) {
          if (canonical(captures.get(capture.id)) !== canonical(capture)) issue('CAPTURE_CONFLICT', 'One capture ID has conflicting contents.', 'blocking', [key]);
          else issue('CAPTURE_REPEATED', 'Repeated capture ID counted once.', 'info', [key]);
          continue;
        }
        captures.set(capture.id, capture);
        evidence.push({ id: key, kind: 'capture', label: 'Capture in order snapshot', facts: { id: capture.id, status: capture.status, amount: capture.amount } });
        if (!CAPTURE_STATES.has(capture.status)) issue('CAPTURE_STATUS_UNKNOWN', 'An unknown capture status requires review.', 'blocking', [key]);
        if (capture.invoice_id && capture.invoice_id !== expected.invoiceId) issue('CAPTURE_INVOICE_MISMATCH', 'Capture invoice does not match.', 'blocking', [key]);
        if (capture.amount?.currency_code !== expected.currencyCode) { issue('CAPTURE_CURRENCY_MISMATCH', 'Capture currency does not match.', 'blocking', [key]); continue; }
        let amount;
        try { amount = toMinor(capture.amount?.value, expected.currencyCode); }
        catch { issue('CAPTURE_AMOUNT_INVALID', 'Capture amount cannot be interpreted safely.', 'blocking', [key]); continue; }
        if (amount <= 0n) issue('CAPTURE_AMOUNT_INVALID', 'Capture amount must be positive.', 'blocking', [key]);
        if (capture.status === 'COMPLETED') completedMinor += amount;
        if (capture.status === 'PENDING') pending = true;
        if (['REFUNDED', 'PARTIALLY_REFUNDED'].includes(capture.status)) refunded = true;
      }
    }
  }

  const seen = new Map();
  for (const envelope of events) {
    const event = envelope?.event;
    if (!event?.id || typeof event.id !== 'string') { issue('EVENT_ID_MISSING', 'Ignored event without a stable ID.', 'warning'); continue; }
    const key = `event:${event.id}`;
    // Invalid signatures never poison the trusted deduplication index.
    if (envelope.verification?.status !== 'SUCCESS' || !SOURCES.has(envelope.source)) { issue('EVENT_UNVERIFIED', 'Unverified event excluded from reconciliation.', 'warning', [key]); continue; }
    if (order && order.source !== envelope.source) { issue('MIXED_PROVENANCE', 'Fixture and sandbox evidence cannot be mixed.', 'blocking', [key]); continue; }
    if (seen.has(event.id)) {
      duplicateEvents++;
      if (seen.get(event.id) !== canonical(event)) issue('EVENT_CONFLICT', 'One verified event ID has conflicting contents.', 'blocking', [key]);
      continue;
    }
    seen.set(event.id, canonical(event));
    evidence.push({ id: key, kind: 'webhook', label: envelope.source === 'synthetic-fixture' ? 'Fixture event (verification simulated)' : 'Signature-verified event', facts: { id: event.id, type: event.event_type, createdAt: event.create_time, source: envelope.source, resourceId: event.resource?.id } });
    const relatedOrder = event.resource?.supplementary_data?.related_ids?.order_id;
    const eventOrderId = event.event_type?.startsWith('CHECKOUT.ORDER.') ? event.resource?.id : relatedOrder;
    if (eventOrderId && eventOrderId !== expected.orderId) { issue('EVENT_UNRELATED', 'Verified event belongs to another order; ignored.', 'info', [key]); continue; }
    const isCaptureEvent = event.event_type?.startsWith('PAYMENT.CAPTURE.');
    const relatedCapture = event.resource?.supplementary_data?.related_ids?.capture_id ?? captureFromUpLink(event.resource);
    const knownCapture = captures.get(relatedCapture ?? event.resource?.id);
    if (!eventOrderId && !knownCapture) { issue('EVENT_UNLINKED', 'Verified event cannot be linked to this order; ignored.', 'warning', [key]); continue; }
    const eventAt = epoch(event.create_time);
    if (!Number.isFinite(eventAt) || eventAt > now) { issue('EVENT_TIME_INVALID', 'Verified event has an invalid or future timestamp.', 'blocking', [key]); continue; }
    if (eventAt > snapshotAt || !Number.isFinite(snapshotAt)) { issue('EVENT_NEWER_THAN_SNAPSHOT', 'A newer verified event requires a fresh order read.', 'blocking', [key]); continue; }
    if (isCaptureEvent && !knownCapture) issue('CAPTURE_NOT_IN_SNAPSHOT', 'A verified capture is absent from the order snapshot; refresh and review.', 'blocking', [key]);
    const refundEvent = isCaptureEvent && ['REFUNDED', 'REVERSED'].some(s => event.event_type.endsWith(`.${s}`));
    if (refundEvent) issue('REFUND_OR_REVERSAL', 'A refund or reversal requires manual reconciliation.', 'blocking', [key]);
    if (isCaptureEvent && knownCapture && event.event_type === 'PAYMENT.CAPTURE.COMPLETED' && ['PENDING', 'DECLINED', 'FAILED'].includes(knownCapture.status)) issue('EVENT_SNAPSHOT_CONFLICT', 'A completed event conflicts with the snapshot capture status.', 'blocking', [key]);
    if (isCaptureEvent && !refundEvent && knownCapture && event.resource?.amount) {
      try {
        if (event.resource.amount.currency_code !== knownCapture.amount.currency_code || toMinor(event.resource.amount.value, event.resource.amount.currency_code) !== toMinor(knownCapture.amount.value, knownCapture.amount.currency_code)) issue('EVENT_AMOUNT_CONFLICT', 'Event and snapshot capture amounts differ.', 'blocking', [key]);
      } catch { issue('EVENT_AMOUNT_INVALID', 'Event capture amount cannot be interpreted safely.', 'blocking', [key]); }
    }
  }
  if (refunded) issue('REFUND_REVIEW', 'Refunded captures need a refund ledger; no net-settlement claim is made.');
  if (data?.status === 'COMPLETED' && captures.size === 0) issue('COMPLETED_WITHOUT_CAPTURE', 'Order status alone does not prove captured funds.');
  if (data?.status === 'VOIDED' && completedMinor > 0n) issue('VOIDED_WITH_CAPTURE', 'Voided order contains completed capture evidence.');
  const blocked = issues.some(x => x.severity === 'blocking');
  let state;
  let allowedActions;
  if (!data) { state = 'unknown'; allowedActions = ['refresh_order']; }
  else if (blocked) { state = 'review_required'; allowedActions = ['refresh_order', 'manual_review']; }
  else if (completedMinor > expectedMinor) { state = 'overpaid'; allowedActions = ['manual_review']; }
  else if (pending) { state = 'pending'; allowedActions = ['wait', 'refresh_order']; }
  else if (completedMinor === expectedMinor) { state = 'paid'; allowedActions = ['record_payment']; }
  else if (completedMinor > 0n) { state = 'underpaid'; allowedActions = ['refresh_order', 'manual_review']; }
  else if (captures.size > 0) { state = 'review_required'; allowedActions = ['refresh_order', 'manual_review']; }
  else if (data.status === 'APPROVED') { state = 'ready_to_capture'; allowedActions = ['capture_order']; }
  else if (['CREATED', 'SAVED', 'PAYER_ACTION_REQUIRED'].includes(data.status)) { state = 'awaiting_approval'; allowedActions = ['request_approval']; }
  else { state = 'review_required'; allowedActions = ['manual_review']; }
  return {
    schemaVersion: '1.0', orderId: expected.orderId, invoiceId: expected.invoiceId, observedAt,
    mode: order?.source === 'paypal-sandbox' ? 'sandbox' : order?.source === 'synthetic-fixture' ? 'fixture' : 'unverified',
    state, allowedActions, issues, evidence, duplicateEvents,
    amounts: {
      currencyCode: expected.currencyCode, expectedMinor: String(expectedMinor), completedMinor: String(completedMinor),
      differenceMinor: String(expectedMinor - completedMinor), expected: fromMinor(expectedMinor, expected.currencyCode),
      completed: fromMinor(completedMinor, expected.currencyCode), difference: fromMinor(expectedMinor - completedMinor, expected.currencyCode),
      scope: 'Current COMPLETED captures only; excludes fees and refunds; not a bank-settlement balance.'
    },
    execution: 'proposal-only'
  };
}
