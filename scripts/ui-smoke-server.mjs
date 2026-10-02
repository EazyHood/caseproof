// Explicitly synthetic browser QA. Never use this server as sandbox evidence.
import { createCaseproofServer } from '../server.mjs';
import { fixtureCase } from '../fixtures/cases.js';

if (process.env.CASEPROOF_UI_FIXTURES !== '1') throw new Error('Set CASEPROOF_UI_FIXTURES=1 for this synthetic-only QA server.');
let reads = 0;
const server = createCaseproofServer({
  env: { PAYPAL_CLIENT_ID: 'injected-qa', PAYPAL_CLIENT_SECRET: 'not-a-credential', CASEPROOF_OLLAMA_MODEL: 'injected-qa' },
  clientFactory: () => ({ async getOrder() {
    reads++;
    if (reads === 1) throw new Error('Deliberate first-read failure to test the Retry button.');
    const { order } = fixtureCase('duplicate-webhook');
    return { ...order, source: 'paypal-sandbox', fetchedAt: new Date().toISOString(), status: 200 };
  }}),
  generateFactory: () => async () => JSON.stringify({
    action: 'record_payment', claimedState: 'paid', claimedCompletedMinor: '4900', currencyCode: 'USD',
    evidenceIds: 'wrong-type-on-purpose', reasonCodes: ['state:paid'],
    explanation: '<img src=x onerror=alert(1)> This is a deliberately invalid test proposal.'
  })
});
server.listen(5190, '127.0.0.1', () => console.log('SYNTHETIC UI QA ONLY: http://127.0.0.1:5190'));
