// Hand-authored synthetic examples. These are NOT PayPal executions or captured replays.
const expected = { orderId: 'FIXTURE-ORDER-001', invoiceId: 'CP-1042', value: '49.00', currencyCode: 'USD' };
const captured = {
  id: expected.orderId, intent: 'CAPTURE', status: 'COMPLETED',
  purchase_units: [{ invoice_id: expected.invoiceId, amount: { currency_code: 'USD', value: '49.00' }, payments: { captures: [
    { id: 'FIXTURE-CAPTURE-001', status: 'COMPLETED', amount: { currency_code: 'USD', value: '49.00' } }
  ] } }]
};
const envelope = {
  source: 'synthetic-fixture', verification: { status: 'SUCCESS', method: 'fixture-assertion-not-cryptographic' },
  event: {
    id: 'FIXTURE-EVENT-001', event_type: 'PAYMENT.CAPTURE.COMPLETED', create_time: '2026-10-02T05:00:00Z',
    resource: { ...captured.purchase_units[0].payments.captures[0], supplementary_data: { related_ids: { order_id: expected.orderId } } }
  }
};
const base = { expected, order: { data: captured, source: 'synthetic-fixture', fetchedAt: '2026-10-02T05:00:10Z' }, observedAt: '2026-10-02T05:00:20Z', events: [] };

export function fixtureCase(name = 'duplicate-webhook') {
  const input = structuredClone(base);
  if (name === 'duplicate-webhook') input.events = [structuredClone(envelope), structuredClone(envelope)];
  else if (name === 'ready-to-capture') { input.order.data.status = 'APPROVED'; delete input.order.data.purchase_units[0].payments; }
  else if (name === 'pending-capture') input.order.data.purchase_units[0].payments.captures[0].status = 'PENDING';
  else if (name === 'amount-mismatch') input.order.data.purchase_units[0].payments.captures[0].amount.value = '39.00';
  else if (name === 'stale-snapshot') input.order.fetchedAt = '2026-10-02T04:00:00Z';
  else if (name === 'unverified-webhook') { input.order.data.status = 'APPROVED'; delete input.order.data.purchase_units[0].payments; const e = structuredClone(envelope); e.verification.status = 'FAILURE'; input.events = [e]; }
  else if (name !== 'paid') throw new TypeError('Unknown fixture case.');
  return input;
}

export const FIXTURE_CASES = ['duplicate-webhook', 'ready-to-capture', 'pending-capture', 'amount-mismatch', 'stale-snapshot', 'unverified-webhook'];
