import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { reconcileCase, createPayPalSandboxClient, createOllamaGenerator, proposeCase, toMinor } from './src/index.js';
import { fixtureCase, FIXTURE_CASES } from './fixtures/cases.js';

const BODY_LIMIT = 16 * 1024;
const INSPECTION_TTL_MS = 5 * 60 * 1000;
const MAX_INSPECTIONS = 128;
const CASES = [
  { id: 'duplicate-webhook', title: 'One payment, two notifications', summary: 'A repeated delivery must not become a second capture.' },
  { id: 'ready-to-capture', title: 'Approved, not captured', summary: 'Buyer approval is visible; no captured payment exists yet.' },
  { id: 'pending-capture', title: 'Capture still pending', summary: 'Wait for a confirmed result before marking the invoice paid.' },
  { id: 'amount-mismatch', title: 'A short payment', summary: 'The captured amount is below the invoice amount.' },
  { id: 'stale-snapshot', title: 'Evidence needs refreshing', summary: 'An old snapshot cannot authorize the next payment decision.' },
  { id: 'unverified-webhook', title: 'An unverified notification', summary: 'A failed signature cannot establish a captured payment.' }
];
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]
]);
const FIXTURE_NOTICE = 'Hand-authored synthetic fixture. No PayPal transaction, authentic webhook verification or bank settlement is demonstrated.';
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function send(res, status, data, contentType = 'application/json; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': contentType });
  res.end(contentType.startsWith('application/json') ? JSON.stringify(data) : data);
}

function checkHost(req) {
  const hostHeaders = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host');
  const host = req.headers.host;
  const match = typeof host === 'string' && /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/i.exec(host);
  const remote = req.socket.remoteAddress;
  if (hostHeaders.length !== 1 || !match || Number(match[2] ?? 80) !== req.socket.localPort || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    throw new HttpError(403, 'HOST_REJECTED', 'This server accepts local loopback requests only.');
  }
  return host.toLowerCase();
}

function checkPost(req, host) {
  if (req.headers.origin !== `http://${host}` || req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'ORIGIN_REJECTED', 'POST requires the exact local page origin.');
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'JSON_REQUIRED', 'Use Content-Type application/json.');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'ENCODING_REJECTED', 'Compressed request bodies are not accepted.');
  if (req.headers['content-length'] && Number(req.headers['content-length']) > BODY_LIMIT) throw new HttpError(413, 'BODY_TOO_LARGE', 'JSON body must be at most 16 KB.');
}

function readJson(req, signal) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', errorHandler); signal.removeEventListener('abort', aborted);
      if (error) { req.resume(); reject(error); } else resolveBody(value);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) return finish(new HttpError(413, 'BODY_TOO_LARGE', 'JSON body must be at most 16 KB.'));
      chunks.push(chunk);
    };
    const end = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        finish(null, value);
      } catch { finish(new HttpError(400, 'INVALID_JSON', 'Send one JSON object.')); }
    };
    const errorHandler = () => finish(new HttpError(400, 'BODY_INTERRUPTED', 'The request body was interrupted.'));
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new HttpError(408, 'BODY_TIMEOUT', 'The request body took too long.')), 10000);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('error', errorHandler); signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function exactFields(body, fields) {
  if (Object.keys(body).length !== fields.length || fields.some(key => !Object.hasOwn(body, key))) throw new HttpError(400, 'INVALID_FIELDS', 'Request fields do not match this operation.');
}

function caseInput(id) {
  if (typeof id !== 'string' || !FIXTURE_CASES.includes(id)) throw new HttpError(404, 'CASE_NOT_FOUND', 'Unknown fixture case.');
  return fixtureCase(id);
}

function inspectInput(body) {
  exactFields(body, ['orderId', 'invoiceId', 'value', 'currencyCode']);
  if (typeof body.orderId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(body.orderId) || typeof body.invoiceId !== 'string' || !body.invoiceId.trim() || body.invoiceId.length > 127 || /[\x00-\x1f\x7f]/.test(body.invoiceId)) throw new HttpError(400, 'INVALID_INPUT', 'A valid order ID and invoice ID are required.');
  try { if (toMinor(body.value, body.currencyCode) <= 0n) throw new Error(); }
  catch { throw new HttpError(400, 'INVALID_AMOUNT', 'Use a positive decimal amount in USD, EUR or GBP, with at most two decimal places.'); }
  return { orderId: body.orderId, invoiceId: body.invoiceId, value: body.value, currencyCode: body.currencyCode };
}

function withSignal(promise, signal) {
  return new Promise((resolveValue, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolveValue, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

/** Local HTTP boundary. Factories are test seams; injected evidence is never labelled real sandbox evidence. */
export function createCaseproofServer({ env = {}, clientFactory, generateFactory, clock = () => Date.now() } = {}) {
  if (typeof clock !== 'function') throw new TypeError('The server clock must be a function.');
  // Capture explicit configuration once; never read ambient credentials when imported by tests.
  const config = {
    clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, model: env.CASEPROOF_OLLAMA_MODEL
  };
  const has = value => typeof value === 'string' && !!value.trim();
  const sandboxConfigured = has(config.clientId) && has(config.clientSecret);
  const aiConfigured = has(config.model);
  // Only the caller's validated expected invoice is retained. Provider JSON,
  // payer information, model output and credentials never enter this cache.
  const inspections = new Map();
  const currentTime = () => {
    const time = clock();
    if (typeof time !== 'number' || !Number.isFinite(time) || !Number.isFinite(new Date(time).getTime())) throw new TypeError('The server clock must return valid epoch milliseconds.');
    return time;
  };
  function pruneInspections(time) {
    for (const [id, entry] of inspections) if (entry.expiresAt <= time) inspections.delete(id);
  }
  function rememberInspection(expected) {
    const time = currentTime();
    pruneInspections(time);
    while (inspections.size >= MAX_INSPECTIONS) inspections.delete(inspections.keys().next().value);
    let resultId;
    do { resultId = randomBytes(32).toString('base64url'); } while (inspections.has(resultId));
    const entry = { expected: Object.freeze({ ...expected }), expiresAt: time + INSPECTION_TTL_MS };
    inspections.set(resultId, entry);
    return { resultId, resultExpiresAt: new Date(entry.expiresAt).toISOString() };
  }
  function lookupInspection(resultId) {
    if (typeof resultId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(resultId)) throw new HttpError(400, 'INVALID_RESULT_ID', 'Use the opaque result ID returned by an order inspection.');
    const entry = inspections.get(resultId);
    if (!entry) throw new HttpError(404, 'INSPECTION_NOT_FOUND', 'This inspection is unavailable. Inspect the order again before requesting a proposal.');
    const time = currentTime();
    if (entry.expiresAt <= time) {
      inspections.delete(resultId);
      throw new HttpError(410, 'INSPECTION_EXPIRED', 'This inspection expired. Inspect the order again before requesting a proposal.');
    }
    pruneInspections(time);
    return entry;
  }
  async function readInspectedOrder(expected, fetchImpl, signal) {
    if (!sandboxConfigured) throw new HttpError(503, 'SANDBOX_NOT_CONFIGURED', 'Server-side PayPal sandbox credentials are not configured. No PayPal request was made.');
    const client = (clientFactory ?? createPayPalSandboxClient)({ clientId: config.clientId, clientSecret: config.clientSecret, fetchImpl, timeoutMs: 15000, signal });
    if (typeof client?.getOrder !== 'function') throw new HttpError(502, 'INVALID_ADAPTER', 'The payment read adapter is unavailable.');
    const received = await withSignal(client.getOrder(expected.orderId), signal);
    if (!received || received.source !== 'paypal-sandbox' || !received.data || typeof received.data !== 'object' || Array.isArray(received.data) || received.data.id !== expected.orderId || !Number.isFinite(Date.parse(received.fetchedAt)) || !Number.isInteger(received.status) || received.status < 200 || received.status >= 300) throw new HttpError(502, 'INVALID_SANDBOX_RESPONSE', 'The payment read returned invalid evidence.');
    const injected = !!clientFactory;
    const order = { data: received.data, source: injected ? 'synthetic-fixture' : 'paypal-sandbox', fetchedAt: received.fetchedAt };
    return {
      result: reconcileCase({ expected, order, events: [], observedAt: new Date(currentTime()).toISOString() }),
      provenance: {
        kind: injected ? 'synthetic-fixture' : 'paypal-sandbox',
        notice: injected ? 'Injected test adapter. This response is not evidence of an authentic PayPal request.' : 'Read from PayPal sandbox using server-side credentials. This inspection does not create or capture orders. Sandbox uses fictitious funds; bank settlement is not verified.'
      }
    };
  }
  const server = http.createServer(async (req, res) => {
    // A rejected request may still be draining when its peer disconnects.
    // Keep an error listener for that lifetime; readJson owns actionable body errors.
    req.on('error', () => {});
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    const lifecycle = new AbortController();
    const timeout = setTimeout(() => lifecycle.abort(new HttpError(504, 'UPSTREAM_TIMEOUT', 'The local operation timed out.')), 55000);
    timeout.unref();
    const disconnected = () => { if (!res.writableEnded) lifecycle.abort(new HttpError(499, 'CLIENT_CLOSED', 'The client disconnected.')); };
    res.once('close', disconnected);
    const scopedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([lifecycle.signal, ...(options.signal ? [options.signal] : [])]) });
    try {
      const host = checkHost(req);
      // Exact paths only: no absolute-form targets, traversal, search strings or arbitrary static paths.
      const path = req.url;
      if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
      if (!['GET', 'POST', 'HEAD'].includes(req.method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
      if (req.method === 'POST') checkPost(req, host);
      if ((req.method === 'GET' || req.method === 'HEAD') && STATIC.has(path)) {
        const [file, contentType] = STATIC.get(path);
        let bytes;
        try { bytes = await readFile(new URL(`./public/${file}`, import.meta.url)); }
        catch { throw new HttpError(404, 'NOT_FOUND', 'Page asset is not available.'); }
        return send(res, 200, req.method === 'HEAD' ? '' : bytes, contentType);
      }
      if (req.method === 'GET' && path === '/api/config') return send(res, 200, { sandboxConfigured, aiConfigured });
      if (req.method === 'GET' && path === '/api/cases') return send(res, 200, { cases: CASES });
      if (req.method === 'GET' && path.startsWith('/api/cases/')) {
        const input = caseInput(path.slice('/api/cases/'.length));
        return send(res, 200, { result: reconcileCase(input), provenance: { kind: 'synthetic-fixture', notice: FIXTURE_NOTICE } });
      }
      if (req.method === 'POST' && path === '/api/analyze') {
        const body = await readJson(req, lifecycle.signal);
        const isFixture = Object.hasOwn(body, 'caseId');
        exactFields(body, [isFixture ? 'caseId' : 'resultId']);
        const inspection = isFixture ? null : lookupInspection(body.resultId);
        let analyzed = isFixture ? { result: reconcileCase(caseInput(body.caseId)), provenance: { kind: 'synthetic-fixture', notice: FIXTURE_NOTICE } } : null;
        if (!aiConfigured) throw new HttpError(503, 'AI_NOT_CONFIGURED', 'Set CASEPROOF_OLLAMA_MODEL to an already available local model. No AI inference was performed.');
        if (config.model.length > 120 || !/^[A-Za-z0-9_.:/-]+$/.test(config.model)) throw new HttpError(503, 'AI_CONFIG_INVALID', 'The configured local model name is invalid.');
        if (inspection) analyzed = await readInspectedOrder(inspection.expected, scopedFetch, lifecycle.signal);
        const generate = (generateFactory ?? createOllamaGenerator)({ model: config.model, fetchImpl: scopedFetch, timeoutMs: 45000, signal: lifecycle.signal });
        const output = await withSignal(proposeCase(analyzed.result, generate), lifecycle.signal);
        return send(res, 200, {
          ...output, result: analyzed.result,
          ...(inspection ? { resultId: body.resultId, resultExpiresAt: new Date(inspection.expiresAt).toISOString() } : {}),
          provenance: { ...analyzed.provenance, inference: generateFactory ? 'injected-test-generator' : 'local-model-response' }
        });
      }
      if (req.method === 'POST' && path === '/api/inspect') {
        const expected = inspectInput(await readJson(req, lifecycle.signal));
        const inspected = await readInspectedOrder(expected, scopedFetch, lifecycle.signal);
        return send(res, 200, { ...inspected, ...rememberInspection(expected) });
      }
      throw new HttpError(404, 'NOT_FOUND', 'Route not found.');
    } catch (error) {
      if (res.destroyed || res.writableEnded || error?.code === 'CLIENT_CLOSED') return;
      const safe = error instanceof HttpError ? error : new HttpError(502, 'UPSTREAM_FAILED', 'The operation failed. No substitute payment evidence or AI output was generated.');
      if (req.method === 'POST') { res.setHeader('Connection', 'close'); req.resume(); }
      send(res, safe.status, { error: { code: safe.code, message: safe.message } });
    } finally {
      clearTimeout(timeout);
      res.off('close', disconnected);
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 50;
  server.once('close', () => inspections.clear());
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createCaseproofServer({ env: process.env });
  server.on('error', () => { console.error('Caseproof could not start on 127.0.0.1:5189.'); process.exitCode = 1; });
  server.listen(5189, '127.0.0.1', () => console.log('Caseproof: http://127.0.0.1:5189 — local, read-only sandbox inspection.'));
}
