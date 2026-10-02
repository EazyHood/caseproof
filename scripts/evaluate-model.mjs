import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, open } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOllamaGenerator, proposeCase, buildProposalMessages } from '../src/ai.js';
import { reconcileCase } from '../src/reconcile.js';
import { FIXTURE_CASES, fixtureCase } from '../fixtures/cases.js';

export const DEFAULT_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
export const EVALUATION_LIMITS = Object.freeze({ contextSize: 4096, maxOutputTokens: 768, timeoutMs: 120000, keepAlive: '2m', temperature: 0 });
const DEFAULT_DIRECTORY = fileURLToPath(new URL('../evidence/model-evaluations/', import.meta.url));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function safeProposal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { value: null, omittedFields: [], projectionApplied: value !== null };
  const allowed = ['action', 'claimedState', 'claimedCompletedMinor', 'currencyCode', 'evidenceIds', 'reasonCodes', 'explanation'];
  const output = {};
  let projectionApplied = false;
  for (const key of allowed) {
    if (!Object.hasOwn(value, key)) continue;
    const item = value[key];
    const safeText = text => typeof text === 'string' && !/\bBearer\s+|[?&](access_token|client_secret|api_key)=/i.test(text);
    if (Array.isArray(item) && ['evidenceIds', 'reasonCodes'].includes(key) && item.length <= 64 && item.every(text => safeText(text) && text.length <= 200)) output[key] = item;
    else if (!['evidenceIds', 'reasonCodes'].includes(key) && safeText(item) && item.length <= (key === 'explanation' ? 2000 : 200)) output[key] = item;
    else projectionApplied = true;
  }
  const omittedFields = Object.keys(value).filter(key => !allowed.includes(key));
  // Unknown field values and raw malformed output are never persisted.
  return { value: output, omittedFields: omittedFields.map(key => /^[A-Za-z0-9_-]{1,64}$/.test(key) ? key : '[unusual-field-name]'), projectionApplied: projectionApplied || omittedFields.length > 0 };
}

async function sourceHashes() {
  const files = ['../src/ai.js', '../src/reconcile.js', '../src/money.js', '../fixtures/cases.js', './evaluate-model.mjs'];
  const hashes = {};
  for (const file of files) hashes[file] = sha256(await readFile(new URL(file, import.meta.url)));
  return hashes;
}

/** Runs the six fixtures sequentially. Supplying fetchImpl marks all results as injected tests. */
export async function evaluateModel({ model = DEFAULT_MODEL, timeoutMs = EVALUATION_LIMITS.timeoutMs, fetchImpl, onCase } = {}) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9_.:/-]{1,160}$/.test(model)) throw new TypeError('A valid local model name is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180000) throw new TypeError('Timeout must be an integer from 1000 to 180000 milliseconds.');
  if (fetchImpl !== undefined && typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function.');
  if (onCase !== undefined && typeof onCase !== 'function') throw new TypeError('onCase must be a function.');
  const injected = fetchImpl !== undefined;
  const report = {
    schemaVersion: '1.0', startedAt: new Date().toISOString(), finishedAt: null,
    requestedModel: model, endpoint: 'http://127.0.0.1:11434/api/chat',
    provenance: {
      inference: injected ? 'injected-test-transport' : 'local-ollama-http',
      input: 'six-hand-authored-synthetic-fixtures',
      notice: 'This evaluates model proposals on synthetic cases, not PayPal connectivity, live payments or merchant outcomes. Structured acceptance does not certify prose truth or general accuracy.'
    },
    limits: { ...EVALUATION_LIMITS, timeoutMs },
    environment: { node: process.version, platform: process.platform, architecture: process.arch },
    sourceSha256: await sourceHashes(),
    cases: [], summary: null
  };
  for (const caseId of FIXTURE_CASES) {
    const result = reconcileCase(fixtureCase(caseId));
    const messages = buildProposalMessages(result);
    let runtime = null;
    let rawResponseSha256 = null;
    const generate = createOllamaGenerator({
      model, timeoutMs, contextSize: 4096, maxOutputTokens: 768, keepAlive: '2m',
      ...(injected ? { fetchImpl } : {}), onResponse: value => { runtime = value; }
    });
    const started = performance.now();
    const record = {
      caseId, startedAt: new Date().toISOString(), latencyMs: null, status: null,
      expected: { state: result.state, allowedActions: result.allowedActions, completedMinor: result.amounts.completedMinor, currencyCode: result.amounts.currencyCode },
      promptSha256: sha256(JSON.stringify(messages)), rawResponseSha256,
      runtime: null, modelMatchesRequest: null, proposal: null, outputProjection: null, validation: null, error: null
    };
    try {
      const output = await proposeCase(result, async request => {
        const raw = await generate(request);
        rawResponseSha256 = sha256(raw);
        return raw;
      });
      const projected = safeProposal(output.proposal);
      record.proposal = projected.value;
      record.outputProjection = { applied: projected.projectionApplied, omittedFields: projected.omittedFields, notice: 'Only bounded known proposal fields are retained. Validation used the original output; the exact original is represented by its SHA-256 hash.' };
      record.validation = output.validation;
      record.status = runtime?.done !== true ? 'incomplete' : output.validation.accepted ? 'accepted' : 'rejected';
    } catch (error) {
      record.status = 'error';
      record.error = {
        code: ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT_OR_ABORT' : 'MODEL_REQUEST_FAILED',
        notice: 'No fallback output was generated. Upstream error text is omitted to avoid retaining private diagnostic data.'
      };
    }
    record.latencyMs = Math.round((performance.now() - started) * 100) / 100;
    record.runtime = runtime;
    record.modelMatchesRequest = runtime?.model ? runtime.model === model : null;
    record.rawResponseSha256 = rawResponseSha256;
    report.cases.push(record);
    if (onCase) await onCase({ caseId, status: record.status, latencyMs: record.latencyMs });
  }
  const count = status => report.cases.filter(item => item.status === status).length;
  report.finishedAt = new Date().toISOString();
  report.summary = {
    total: report.cases.length, accepted: count('accepted'), rejected: count('rejected'), errors: count('error'), incomplete: count('incomplete'),
    completedModelResponses: report.cases.filter(item => item.runtime?.done === true).length,
    reportedModels: [...new Set(report.cases.map(item => item.runtime?.model).filter(Boolean))],
    allReportedModelsMatchRequest: report.cases.every(item => item.modelMatchesRequest === true),
    actualLocalInferenceObserved: !injected && report.cases.some(item => item.runtime?.done === true),
    allCasesCompleted: report.cases.every(item => ['accepted', 'rejected'].includes(item.status)),
    totalCaseLatencyMs: Math.round(report.cases.reduce((sum, item) => sum + item.latencyMs, 0) * 100) / 100
  };
  return report;
}

export async function saveEvaluation(report, { directory = DEFAULT_DIRECTORY } = {}) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new TypeError('An absolute artifact directory is required.');
  if (report?.schemaVersion !== '1.0' || !Array.isArray(report.cases) || report.cases.length !== 6) throw new TypeError('A complete six-case evaluation report is required.');
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(json) > 256 * 1024) throw new TypeError('Evaluation artifact exceeds 256 KB.');
  await mkdir(directory, { recursive: true });
  const stamp = report.startedAt.replace(/[^0-9]/g, '').slice(0, 17);
  const path = join(directory, `evaluation-${stamp}-${randomUUID().slice(0, 8)}.json`);
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(json); await file.sync(); } finally { await file.close(); }
  return path;
}

async function main(args) {
  if (!args.includes('--run') || args.includes('--help')) {
    console.log('Prepared only; no inference executed.\nRun explicitly after the model is available:\n  node scripts/evaluate-model.mjs --run [--model LOCAL_MODEL]');
    return;
  }
  let model = DEFAULT_MODEL;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--run') continue;
    if (args[index] === '--model' && args[index + 1]) { model = args[++index]; continue; }
    throw new TypeError('Unsupported argument. Use --run and optionally --model LOCAL_MODEL.');
  }
  const report = await evaluateModel({ model, onCase: item => console.log(`${item.caseId}: ${item.status}, ${item.latencyMs} ms`) });
  const path = await saveEvaluation(report);
  console.log(JSON.stringify({ artifact: path, requestedModel: report.requestedModel, ...report.summary }, null, 2));
  if (report.summary.errors || report.summary.incomplete || report.summary.rejected) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Evaluation could not complete. No private diagnostic text is printed.'); process.exitCode = 1; });
}
