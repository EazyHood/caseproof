import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileCase, validateProposal, proposeCase, createOllamaGenerator } from '../src/index.js';
import { fixtureCase } from '../fixtures/cases.js';

const result = () => reconcileCase(fixtureCase());
const good = () => ({ action: 'record_payment', claimedState: 'paid', claimedCompletedMinor: '4900', currencyCode: 'USD', evidenceIds: ['expected', 'order:FIXTURE-ORDER-001', 'capture:FIXTURE-CAPTURE-001'], reasonCodes: ['state:paid'], explanation: 'The fixture invoice has one completed capture for the expected amount. Repeated delivery does not add a second capture.' });

test('valid structured AI proposal remains non-executing with prose verification limit visible', () => {
  const checked = validateProposal(result(), good());
  assert.equal(checked.accepted, true);
  assert.equal(checked.structuredAssertionsVerified, true);
  assert.equal(checked.explanationVerified, false);
  assert.equal(checked.execution, 'none');
});

test('hallucinated action, money, state, evidence, reason and missing support are rejected', () => {
  const mutations = [
    p => { p.action = 'capture_order'; }, p => { p.claimedCompletedMinor = '9800'; }, p => { p.currencyCode = 'EUR'; },
    p => { p.claimedState = 'ready_to_capture'; }, p => { p.evidenceIds.push('invented-receipt'); },
    p => { p.reasonCodes = ['BANK_SETTLED']; }, p => { p.evidenceIds = ['expected']; }, p => { p.execute = true; }
  ];
  for (const mutate of mutations) { const proposal = good(); mutate(proposal); assert.equal(validateProposal(result(), proposal).accepted, false); }
});

test('model output is validated and invalid JSON has no fabricated fallback', async () => {
  const accepted = await proposeCase(result(), async ({ messages, schema }) => {
    assert.ok(messages[0].content.includes('untrusted data'));
    assert.equal(schema.additionalProperties, false);
    return JSON.stringify(good());
  });
  assert.equal(accepted.validation.accepted, true);
  const rejected = await proposeCase(result(), async () => 'not JSON');
  assert.equal(rejected.validation.accepted, false);
  assert.equal(rejected.proposal, null);
});

test('local model adapter uses schema, disables streaming and refuses non-loopback endpoints', async () => {
  assert.throws(() => createOllamaGenerator({ model: 'existing-model', baseUrl: 'https://remote.example' }), /loopback/);
  let request;
  const generate = createOllamaGenerator({ model: 'existing-model', fetchImpl: async (url, options) => {
    request = { url, ...options }; return new Response(JSON.stringify({ message: { content: JSON.stringify(good()) } }));
  } });
  const output = await proposeCase(result(), generate);
  assert.equal(output.validation.accepted, true);
  const body = JSON.parse(request.body);
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(body.stream, false);
  assert.equal(body.format.type, 'object');
  assert.equal(body.model, 'existing-model');
  assert.equal(request.redirect, 'error');
});

test('AI service failure is observable rather than replaced with a claimed model result', async () => {
  const generate = createOllamaGenerator({ model: 'missing-model', fetchImpl: async () => new Response('{}', { status: 404 }) });
  await assert.rejects(proposeCase(result(), generate), /no fallback/);
});

test('malformed evidence arrays are rejected without throwing from validation', () => {
  for (const evidenceIds of [{}, null, 2, 'expected']) {
    assert.equal(validateProposal(result(), { ...good(), evidenceIds }).accepted, false);
  }
});

test('case-bound decoding cannot replace independent checks of disallowed actions or future money', async () => {
  const current = reconcileCase(fixtureCase('amount-mismatch'));
  const output = await proposeCase(current, async ({ schema }) => {
    assert.equal(schema.properties.action.enum.includes('capture_order'), false);
    assert.deepEqual(schema.properties.claimedCompletedMinor.enum, ['3900']);
    assert.deepEqual(schema.properties.claimedState.enum, ['underpaid']);
    assert.ok(schema.properties.reasonCodes.items.enum.includes('state:underpaid'));
    // A transport/model may ignore a decoding schema; this must still be rejected.
    return { ...good(), action: 'capture_order', claimedState: 'paid', claimedCompletedMinor: '4900' };
  });
  assert.equal(output.validation.accepted, false);
  assert.equal(output.validation.execution, 'none');
});
