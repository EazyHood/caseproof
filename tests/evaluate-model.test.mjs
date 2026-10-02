import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateModel, saveEvaluation, DEFAULT_MODEL } from '../scripts/evaluate-model.mjs';
import { createOllamaGenerator } from '../src/ai.js';

const reply = (proposal, extra = {}) => new Response(JSON.stringify({ model: DEFAULT_MODEL, done: true, done_reason: 'stop', total_duration: 2000000, load_duration: 500000, prompt_eval_count: 700, eval_count: 180, message: { content: typeof proposal === 'string' ? proposal : JSON.stringify(proposal) }, ...extra }));
function validProposal(request) {
  const result = JSON.parse(JSON.parse(request.body).messages[1].content);
  return { action: result.allowedActions[0], claimedState: result.state, claimedCompletedMinor: result.amounts.completedMinor, currencyCode: result.amounts.currencyCode, evidenceIds: result.evidence.map(item => item.id), reasonCodes: [`state:${result.state}`], explanation: 'This synthetic case follows the cited reconciliation evidence.' };
}

test('evaluation executes six serial bounded chat requests and labels injected transport honestly', async () => {
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  const report = await evaluateModel({ fetchImpl: async (url, options) => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    assert.equal(url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(options.body);
    assert.equal(body.model, DEFAULT_MODEL);
    assert.equal(body.stream, false);
    assert.equal(body.keep_alive, '2m');
    assert.deepEqual(body.options, { temperature: 0, num_ctx: 4096, num_predict: 768 });
    assert.equal(body.format.additionalProperties, false);
    await Promise.resolve(); active--;
    return reply(validProposal(options));
  } });
  assert.equal(calls, 6); assert.equal(maxActive, 1);
  assert.equal(report.summary.accepted, 6);
  assert.equal(report.summary.actualLocalInferenceObserved, false);
  assert.equal(report.provenance.inference, 'injected-test-transport');
  assert.ok(report.cases.every(item => item.latencyMs >= 0 && item.runtime.evalCount === 180 && item.rawResponseSha256.length === 64));
  assert.equal(report.cases[0].validation.explanationVerified, false);
});

test('rejections, malformed JSON, incomplete responses and service errors remain distinct', async () => {
  let count = 0;
  const report = await evaluateModel({ fetchImpl: async (_url, options) => {
    count++;
    if (count === 1) return reply({ ...validProposal(options), claimedCompletedMinor: '999999' });
    if (count === 2) return reply('not valid JSON');
    if (count === 3) return reply(validProposal(options), { done: false });
    if (count === 4) throw new Error('SECRET-UPSTREAM-DIAGNOSTIC');
    return reply(validProposal(options));
  } });
  assert.equal(report.summary.rejected, 2);
  assert.equal(report.summary.incomplete, 1);
  assert.equal(report.summary.errors, 1);
  assert.equal(report.summary.accepted, 2);
  assert.equal(report.summary.allCasesCompleted, false);
  assert.equal(report.cases[1].proposal, null);
  assert.ok(!JSON.stringify(report).includes('SECRET-UPSTREAM-DIAGNOSTIC'));
});

test('timeout is reported without replacement inference and response model is recorded', async () => {
  let count = 0;
  const report = await evaluateModel({ timeoutMs: 1000, fetchImpl: async (_url, options) => {
    if (count++ === 0) throw new DOMException('sensitive timeout detail', 'TimeoutError');
    return reply(validProposal(options), { model: 'different:reported-model' });
  } });
  assert.equal(report.cases[0].error.code, 'TIMEOUT_OR_ABORT');
  assert.equal(report.cases[1].runtime.model, 'different:reported-model');
  assert.ok(!JSON.stringify(report).includes('sensitive timeout detail'));
});

test('unknown model output fields are validated but values are not retained in the artifact', async () => {
  const report = await evaluateModel({ fetchImpl: async (_url, options) => reply({ ...validProposal(options), api_key: 'DO-NOT-RETAIN' }) });
  assert.equal(report.summary.rejected, 6);
  assert.equal(report.cases[0].outputProjection.applied, true);
  assert.deepEqual(report.cases[0].outputProjection.omittedFields, ['api_key']);
  assert.ok(!JSON.stringify(report).includes('DO-NOT-RETAIN'));
});

test('artifact writes are unique, contain runtime/config/source hashes and preserve injected provenance', async t => {
  const testsRoot = dirname(fileURLToPath(import.meta.url));
  const directory = await mkdtemp(join(testsRoot, '.model-evaluation-test-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(`${resolve(testsRoot)}${sep}.model-evaluation-test-`)); await rm(directory, { recursive: true, force: true }); });
  const report = await evaluateModel({ fetchImpl: async (_url, options) => reply(validProposal(options)) });
  const first = await saveEvaluation(report, { directory });
  const second = await saveEvaluation(report, { directory });
  assert.notEqual(first, second);
  const stored = JSON.parse(await readFile(first, 'utf8'));
  assert.equal(stored.cases.length, 6);
  assert.equal(stored.summary.actualLocalInferenceObserved, false);
  assert.equal(stored.limits.contextSize, 4096);
  assert.equal(Object.keys(stored.sourceSha256).length, 5);
});

test('unbounded model options and invalid names are rejected before contacting a service', async () => {
  for (const options of [{ contextSize: 32768 }, { maxOutputTokens: -1 }, { maxOutputTokens: 4096 }, { keepAlive: '-1' }]) assert.throws(() => createOllamaGenerator({ model: DEFAULT_MODEL, ...options }));
  await assert.rejects(evaluateModel({ model: 'model with spaces' }));
  await assert.rejects(evaluateModel({ timeoutMs: 600000 }));
});
