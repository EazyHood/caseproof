import { createPayPalSandboxClient, reconcileCase } from './index.js';

// Opt-in read-only CLI. It does not create or capture an order, print raw responses, or save credentials.
try {
  const { PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ORDER_ID, CASEPROOF_INVOICE_ID, CASEPROOF_EXPECTED_VALUE, CASEPROOF_CURRENCY = 'USD' } = process.env;
  if (![PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ORDER_ID, CASEPROOF_INVOICE_ID, CASEPROOF_EXPECTED_VALUE].every(Boolean)) throw new Error('Set sandbox credentials, PAYPAL_ORDER_ID, CASEPROOF_INVOICE_ID and CASEPROOF_EXPECTED_VALUE in the process environment.');
  const client = createPayPalSandboxClient({ clientId: PAYPAL_CLIENT_ID, clientSecret: PAYPAL_CLIENT_SECRET });
  const order = await client.getOrder(PAYPAL_ORDER_ID);
  const result = reconcileCase({ expected: { orderId: PAYPAL_ORDER_ID, invoiceId: CASEPROOF_INVOICE_ID, value: CASEPROOF_EXPECTED_VALUE, currencyCode: CASEPROOF_CURRENCY }, order, events: [], observedAt: new Date().toISOString() });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
