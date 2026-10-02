import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createEvidenceStore } from '../src/evidence-store.js';
import { createPayPalSandboxClient } from '../src/paypal.js';

const BODY_LIMIT = 64 * 1024;
const SIGNATURE_HEADERS = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'];
const CASE_ID = /^(?!con$|prn$|aux$|nul$|com[1-9]$|lpt[1-9]$)[a-z0-9][a-z0-9_-]{0,63}$/;
const RESOURCE_ID = /^[A-Za-z0-9-]{1,64}$/;
const DEFAULT_STORE = fileURLToPath(new URL('../evidence/private/sandbox-cases/', import.meta.url));
const HELP = `Caseproof sandbox webhook receiver — no listener starts by default.
Start: node scripts/webhook-server.mjs --run --case CASE_ID [--case CASE_ID] [--store ABSOLUTE_PATH]
Requires PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_WEBHOOK_ID in the process environment.
Optional CASEPROOF_WEBHOOK_PATH=/webhooks/paypal/<24-96 URL-safe characters>; otherwise generated randomly.
Optional CASEPROOF_WEBHOOK_PORT (default 5190) and CASEPROOF_WEBHOOK_HOST (one exact tunnel hostname).
Binds 127.0.0.1 only. Does not create a tunnel, register a webhook, load .env or expose a status page.
Use the webhook ID for this sandbox app and endpoint. No credentials are accepted as arguments.`;

class ReceiverError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const stop = (status, code) => { throw new ReceiverError(status, code); };
const configured = value => typeof value === 'string' && value.trim().length > 0;
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

function send(res, status, code) {
  if (res.destroyed || res.writableEnded) return;
  if (status === 503) res.setHeader('Retry-After', '5');
  // Same acknowledgement for an ignored, saved or duplicate verified event.
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' });
  res.end(JSON.stringify(status === 200 ? { received: true } : { error: { code } }));
}

function rawCount(req, name) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}

function checkRequest(req, routePath, allowedHostnames) {
  const host = req.headers.host;
  if (rawCount(req, 'host') !== 1 || typeof host !== 'string' || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) stop(403, 'HOST_REJECTED');
  const local = /^(127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?$/i.exec(host);
  const external = /^([a-z0-9.-]+)(?::443)?$/i.exec(host);
  const localAllowed = local && Number(local[2] ?? 80) === req.socket.localPort;
  const externalAllowed = external && allowedHostnames.has(external[1].toLowerCase());
  if (!localAllowed && !externalAllowed) stop(403, 'HOST_REJECTED');
  // Compare the raw target: no query strings, encoded aliases or absolute-form URLs.
  if (req.url !== routePath) stop(404, 'NOT_FOUND');
  if (req.method !== 'POST') stop(405, 'METHOD_NOT_ALLOWED');
  if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) stop(403, 'BROWSER_REQUEST_REJECTED');
  if (rawCount(req, 'content-type') !== 1 || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/i.test(req.headers['content-type'] ?? '')) stop(415, 'JSON_REQUIRED');
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') stop(415, 'ENCODING_REJECTED');
  if (req.headers['content-length'] && Number(req.headers['content-length']) > BODY_LIMIT) stop(413, 'BODY_TOO_LARGE');
  const headers = {};
  for (const name of SIGNATURE_HEADERS) {
    const value = req.headers[name];
    if (rawCount(req, name) !== 1 || typeof value !== 'string' || !/^[\x21-\x7e][\x20-\x7e]{0,999}$/.test(value)) stop(400, 'SIGNATURE_HEADERS_REQUIRED');
    headers[name] = value;
  }
  return headers;
}

function parseEvent(bytes) {
  let text, event;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); event = JSON.parse(text); }
  catch { stop(400, 'INVALID_JSON'); }
  // JSON.parse alone silently replaces duplicate keys. Reject ambiguous input,
  // excessive nesting and non-finite numbers before sending the original object.
  let index = 0;
  const whitespace = () => { while (/\s/.test(text[index] ?? '') && index < text.length) index++; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      const char = text[index++];
      if (char === '\\') index++;
      else if (char === '"') return JSON.parse(text.slice(start, index));
    }
    stop(400, 'INVALID_JSON');
  };
  const value = depth => {
    if (depth > 32) stop(400, 'INVALID_JSON');
    whitespace();
    if (text[index] === '"') { string(); return; }
    if (text[index] === '{') {
      index++; whitespace();
      const keys = new Set();
      if (text[index] === '}') { index++; return; }
      while (true) {
        whitespace(); const key = string();
        if (keys.has(key)) stop(400, 'INVALID_JSON');
        keys.add(key); whitespace(); index++; value(depth + 1); whitespace();
        if (text[index++] === '}') return;
      }
    }
    if (text[index] === '[') {
      index++; whitespace();
      if (text[index] === ']') { index++; return; }
      while (true) { value(depth + 1); whitespace(); if (text[index++] === ']') return; }
    }
    const start = index;
    while (index < text.length && !/[\s,\]}]/.test(text[index])) index++;
    const scalar = JSON.parse(text.slice(start, index));
    if (typeof scalar === 'number' && !Number.isFinite(scalar)) stop(400, 'INVALID_JSON');
  };
  value(0);
  if (!event || typeof event !== 'object' || Array.isArray(event) || !RESOURCE_ID.test(event.id ?? '') || typeof event.event_type !== 'string' || !/^[A-Z0-9_.]{1,100}$/.test(event.event_type) || !validTime(event.create_time) || !event.resource || typeof event.resource !== 'object' || Array.isArray(event.resource)) stop(400, 'INVALID_EVENT');
  return event;
}

function readEvent(req, signal, bodyTimeoutMs) {
  return new Promise((resolveBody, reject) => {
    let size = 0, settled = false;
    const chunks = [];
    const finish = (error, event) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('aborted', interrupted); req.off('error', interrupted);
      signal.removeEventListener('abort', aborted);
      if (error) { req.resume(); reject(error); } else resolveBody(event);
    };
    const data = chunk => {
      size += chunk.length;
      if (size > BODY_LIMIT) return finish(new ReceiverError(413, 'BODY_TOO_LARGE'));
      chunks.push(chunk);
    };
    const end = () => { try { finish(null, parseEvent(Buffer.concat(chunks))); } catch (error) { finish(error); } };
    const interrupted = () => finish(new ReceiverError(400, 'BODY_INTERRUPTED'));
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new ReceiverError(408, 'BODY_TIMEOUT')), bodyTimeoutMs);
    timer.unref();
    req.on('data', data); req.once('end', end); req.once('aborted', interrupted); req.once('error', interrupted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

function withSignal(promise, signal) {
  return new Promise((resolveValue, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolveValue, reject).finally(() => signal.removeEventListener('abort', aborted));
    if (signal.aborted) aborted();
  });
}

function captureReference(resource) {
  const explicit = resource?.supplementary_data?.related_ids?.capture_id;
  if (explicit) return explicit;
  for (const link of Array.isArray(resource?.links) ? resource.links : []) {
    if (link?.rel !== 'up' || typeof link.href !== 'string') continue;
    try {
      const url = new URL(link.href);
      const match = url.pathname.match(/^\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/);
      if (url.protocol === 'https:' && ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(url.hostname) && match) return match[1];
    } catch { /* A malformed link cannot associate an event with a case. */ }
  }
  return resource?.id;
}

async function findCase(store, caseIds, event, source, signal) {
  const orderEvent = event.event_type.startsWith('CHECKOUT.ORDER.');
  const related = event.resource.supplementary_data?.related_ids;
  const orderId = orderEvent ? event.resource.id : related?.order_id;
  const hasOrderReference = orderEvent || (related && Object.hasOwn(related, 'order_id'));
  if (hasOrderReference && (typeof orderId !== 'string' || !RESOURCE_ID.test(orderId))) stop(503, 'INVALID_EVENT_REFERENCE');
  const captureId = captureReference(event.resource);
  const matches = [], captureMatches = [];
  for (const caseId of caseIds) {
    const state = await withSignal(store.readCase(caseId), signal);
    if (state.source !== source) stop(503, 'CASE_SOURCE_MISMATCH');
    const hasCapture = state.snapshots.some(snapshot => (snapshot.data.purchase_units[0].payments?.captures ?? []).some(capture => capture.id === captureId));
    if (hasCapture) captureMatches.push(caseId);
    // An explicit order reference always takes precedence; never rescue a
    // conflicting order reference using a familiar capture ID.
    if (hasOrderReference ? orderId === state.expected.orderId : hasCapture) matches.push(caseId);
  }
  if (matches.length > 1 || (matches.length === 1 && captureMatches.some(id => id !== matches[0]))) stop(503, 'AMBIGUOUS_CASE');
  return matches[0] ?? null;
}

/** No ambient environment reads or listening. Injected clients can only write fixture cases. */
export function createWebhookServer({ store, caseIds, env = {}, clientFactory, routePath = `/webhooks/paypal/${randomBytes(24).toString('hex')}`, allowedHostnames = [], operationTimeoutMs = 40000, bodyTimeoutMs = 10000, maxInFlight = 4 } = {}) {
  if (!store || typeof store.readCase !== 'function' || typeof store.saveVerifiedWebhook !== 'function') throw new TypeError('An evidence store is required.');
  if (!Array.isArray(caseIds) || !caseIds.length || caseIds.length > 16 || caseIds.some(id => typeof id !== 'string' || !CASE_ID.test(id)) || new Set(caseIds).size !== caseIds.length) throw new TypeError('Provide 1–16 unique valid case IDs.');
  if (typeof routePath !== 'string' || !/^\/webhooks\/paypal\/[A-Za-z0-9_-]{24,96}$/.test(routePath)) throw new TypeError('Use a webhook path with a 24–96 character URL-safe token.');
  if (!Array.isArray(allowedHostnames) || allowedHostnames.length > 4 || allowedHostnames.some(host => typeof host !== 'string' || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || host === 'localhost')) throw new TypeError('Tunnel hostnames must be explicit lower-case DNS names without ports.');
  if (!Number.isInteger(operationTimeoutMs) || operationTimeoutMs < 1 || operationTimeoutMs > 60000 || !Number.isInteger(bodyTimeoutMs) || bodyTimeoutMs < 1 || bodyTimeoutMs > 10000 || !Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 4) throw new TypeError('Invalid receiver limits.');
  const selectedCases = [...caseIds], hosts = new Set(allowedHostnames);
  const config = { clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, webhookId: env.PAYPAL_WEBHOOK_ID };
  const source = clientFactory ? 'synthetic-fixture' : 'paypal-sandbox';
  let inFlight = 0;
  const server = http.createServer({ maxHeaderSize: 12 * 1024 }, async (req, res) => {
    req.on('error', () => {});
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    const lifecycle = new AbortController();
    let timer, counted = false;
    const disconnected = () => { if (!res.writableEnded) lifecycle.abort(new ReceiverError(499, 'CLIENT_CLOSED')); };
    res.once('close', disconnected);
    try {
      const headers = checkRequest(req, routePath, hosts);
      if (!Object.values(config).every(configured)) stop(503, 'SANDBOX_NOT_CONFIGURED');
      if (inFlight >= maxInFlight) stop(503, 'RECEIVER_BUSY');
      inFlight++; counted = true;
      timer = setTimeout(() => {
        lifecycle.abort(new ReceiverError(503, 'RECEIVER_TIMEOUT'));
        // A started disk append is not cancellable. It may finish after this
        // negative acknowledgement; the delivery retry is durably deduplicated.
        send(res, 503, 'RECEIVER_TIMEOUT');
      }, operationTimeoutMs);
      timer.unref();
      const event = await readEvent(req, lifecycle.signal, bodyTimeoutMs);
      const originalEvent = structuredClone(event);
      lifecycle.signal.throwIfAborted();
      const scopedFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.any([lifecycle.signal, ...(options.signal ? [options.signal] : [])]) });
      const client = (clientFactory ?? createPayPalSandboxClient)({ ...config, fetchImpl: scopedFetch, timeoutMs: 15000, signal: lifecycle.signal });
      if (client?.environment !== 'sandbox' || typeof client.verifyWebhook !== 'function') stop(503, 'INVALID_ADAPTER');
      const verified = await withSignal(client.verifyWebhook({ headers, event }), lifecycle.signal);
      if (verified?.verification?.status !== 'SUCCESS') stop(401, 'VERIFICATION_FAILED');
      if (verified.source !== 'paypal-sandbox' || verified.verification.method !== 'paypal-postback' || !validTime(verified.receivedAt) || !validTime(verified.verification.checkedAt) || !isDeepStrictEqual(verified.event, originalEvent) || Object.keys(verified).sort().join(',') !== 'event,receivedAt,source,verification') stop(503, 'INVALID_VERIFIED_EVENT');
      // Production receives the exact adapter envelope. This explicit test seam
      // changes provenance only and can never write into a sandbox case.
      const envelope = clientFactory ? { ...verified, source, verification: { ...verified.verification, method: 'fixture-assertion-not-cryptographic' } } : verified;
      const caseId = await findCase(store, selectedCases, envelope.event, source, lifecycle.signal);
      lifecycle.signal.throwIfAborted();
      if (caseId) {
        await store.saveVerifiedWebhook(caseId, envelope);
        lifecycle.signal.throwIfAborted();
      }
      send(res, 200);
    } catch (error) {
      req.resume();
      const safe = error instanceof ReceiverError ? error : new ReceiverError(503, 'RECEIVER_UNAVAILABLE');
      if (safe.code !== 'CLIENT_CLOSED') send(res, safe.status, safe.code);
    } finally {
      clearTimeout(timer); res.off('close', disconnected);
      if (counted) inFlight--;
    }
  });
  server.headersTimeout = 10000; server.requestTimeout = 15000; server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 40; server.maxConnections = 16;
  server.on('checkContinue', (_req, res) => send(res, 417, 'EXPECTATION_REJECTED'));
  server.on('checkExpectation', (_req, res) => send(res, 417, 'EXPECTATION_REJECTED'));
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return;
    // Malformed trailing bytes must not append a second HTTP response after an
    // earlier rejection on this Connection: close socket.
    socket.end(socket.bytesWritten ? undefined : 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  Object.defineProperties(server, { webhookPath: { value: routePath, enumerable: true }, evidenceSource: { value: source, enumerable: true } });
  return server;
}

export function parseWebhookArgs(args) {
  if (!args.length || args.includes('--help')) return { help: true };
  const result = { caseIds: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--run' && !result.run) result.run = true;
    else if ((arg === '--case' || arg === '--store') && args[i + 1] && !args[i + 1].startsWith('--')) {
      if (arg === '--case') result.caseIds.push(args[++i]);
      else { if (result.directory) throw new TypeError('Repeated store option.'); result.directory = args[++i]; }
    } else throw new TypeError('Unknown or repeated option.');
  }
  if (!result.run || !result.caseIds.length) throw new TypeError('Explicit --run and --case are required.');
  return result;
}

async function main(args) {
  const parsed = parseWebhookArgs(args);
  if (parsed.help) { console.log(HELP); return; }
  if (![process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET, process.env.PAYPAL_WEBHOOK_ID].every(configured)) throw new Error('Missing configuration.');
  const port = Number(process.env.CASEPROOF_WEBHOOK_PORT ?? 5190);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port.');
  const store = await createEvidenceStore({ directory: parsed.directory ?? DEFAULT_STORE });
  for (const id of parsed.caseIds) if ((await store.readCase(id)).source !== 'paypal-sandbox') throw new Error('Invalid case source.');
  const server = createWebhookServer({ store, caseIds: parsed.caseIds, env: process.env, routePath: process.env.CASEPROOF_WEBHOOK_PATH, allowedHostnames: process.env.CASEPROOF_WEBHOOK_HOST ? [process.env.CASEPROOF_WEBHOOK_HOST] : [] });
  server.on('error', () => { console.error('Webhook receiver could not listen on the configured loopback port.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Caseproof sandbox webhook receiver: http://127.0.0.1:${port}${server.webhookPath}\nLocal listener only; no public endpoint or PayPal registration was created.`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => { console.error('Webhook receiver did not start. Check explicit arguments, sandbox environment configuration and private case store. No private diagnostics are printed.'); process.exitCode = 1; });
}
