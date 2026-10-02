import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { toMinor } from './money.js';

const MAX_RECORD_BYTES = 128 * 1024;
const MAX_CASE_BYTES = 1024 * 1024;
const queues = new Map();
const SOURCES = new Set(['paypal-sandbox', 'synthetic-fixture']);
const SECRET_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|password|passwd|secret|client_secret|clientsecret|access_token|accesstoken|refresh_token|refreshtoken|api_key|apikey|private_key|privatekey|headers)$/i;
const HASH = /^[a-f0-9]{64}$/;

export class EvidenceStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'EvidenceStoreError'; this.code = code; }
}
const fail = (code, message) => { throw new EvidenceStoreError(code, message); };
const digest = text => createHash('sha256').update(text).digest('hex');
const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const jsonCopy = input => {
  const visited = new WeakSet();
  const walk = (value, depth = 0) => {
    if (depth > 32) fail('INVALID_JSON', 'Evidence nesting exceeds the supported limit.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      if (/\bBearer\s+[A-Za-z0-9._~-]+/i.test(value) || /[?&](access_token|client_secret|api_key)=/i.test(value)) fail('SECRET_REJECTED', 'Evidence contains a recognized credential pattern.');
      return value;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (!value || typeof value !== 'object' || visited.has(value)) fail('INVALID_JSON', 'Evidence must contain finite, non-cyclic JSON values.');
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('INVALID_JSON', 'Evidence must use plain JSON objects.');
    visited.add(value);
    let copy;
    if (Array.isArray(value)) {
      if (Object.keys(value).length !== value.length) fail('INVALID_JSON', 'Evidence arrays cannot contain holes or extra properties.');
      copy = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_JSON', 'Evidence arrays must contain plain values, not holes or accessors.');
        copy.push(walk(descriptor.value, depth + 1));
      }
    }
    else {
      copy = Object.create(null);
      for (const key of Object.keys(value)) {
        if (SECRET_KEY.test(key)) fail('SECRET_REJECTED', 'Evidence contains a prohibited credential or header field.');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_JSON', 'Evidence cannot contain accessors.');
        copy[key] = walk(descriptor.value, depth + 1);
      }
    }
    visited.delete(value);
    return copy;
  };
  const copy = walk(input);
  const encoded = JSON.stringify(copy);
  if (Buffer.byteLength(encoded) > MAX_RECORD_BYTES - 2048) fail('RECORD_TOO_LARGE', 'Evidence exceeds the 128 KB record limit.');
  return JSON.parse(encoded);
};

const caseKey = value => {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) fail('INVALID_CASE_ID', 'Case IDs must be lowercase letters, digits, underscores or hyphens, excluding device names.');
  return value;
};
const paypalId = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
const timestamp = (value, ceiling) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && Date.parse(value) <= ceiling;
const same = (a, b) => canonical(a) === canonical(b);
function relatedCaptureId(resource) {
  if (resource?.supplementary_data?.related_ids?.capture_id) return resource.supplementary_data.related_ids.capture_id;
  for (const link of Array.isArray(resource?.links) ? resource.links : []) {
    if (link?.rel !== 'up' || typeof link.href !== 'string') continue;
    try {
      const url = new URL(link.href);
      const match = url.pathname.match(/^\/v2\/payments\/captures\/([A-Za-z0-9-]+)$/);
      if (url.protocol === 'https:' && ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(url.hostname) && match) return match[1];
    } catch { /* Invalid links cannot establish an evidence relationship. */ }
  }
  return resource?.id;
}

function validateExpected(value) {
  if (!value || typeof value !== 'object' || typeof value.invoiceId !== 'string' || !value.invoiceId.trim() || value.invoiceId.length > 127 || /[\x00-\x1f\x7f]/.test(value.invoiceId) || Object.keys(value).some(key => !['invoiceId', 'value', 'currencyCode', 'orderId'].includes(key))) fail('INVALID_EXPECTED', 'A valid invoice, amount and currency are required.');
  try { if (toMinor(value.value, value.currencyCode) <= 0n) throw new Error(); }
  catch { fail('INVALID_EXPECTED', 'The invoice amount must be positive and use a supported currency.'); }
  if (value.orderId !== undefined && !paypalId(value.orderId)) fail('INVALID_EXPECTED', 'The optional PayPal order ID is invalid.');
}

function captureIdentity(capture) {
  let amount = capture.amount;
  if (amount && typeof amount === 'object' && !Array.isArray(amount)) {
    try { amount = { ...amount, value: toMinor(amount.value, amount.currency_code).toString() }; }
    catch { /* Unknown or malformed money remains an exact comparison, never a guessed value. */ }
  }
  return { amount, invoice_id: capture.invoice_id ?? null };
}

function project(caseId, records) {
  if (!records.length || records[0].type !== 'case_created') fail('CORRUPT_STORE', 'The case is missing its creation record.');
  const initial = records[0];
  const state = { schemaVersion: '1.0', caseId, source: initial.payload.source, expected: { ...initial.payload.expected }, createdAt: initial.recordedAt, updatedAt: records.at(-1).recordedAt, requests: [], snapshots: [], events: [], records };
  for (const record of records.slice(1)) {
    if (record.type === 'request_reserved') state.requests.push({ ...record.payload, recordedAt: record.recordedAt, recordHash: record.hash });
    else if (record.type === 'snapshot_saved') {
      state.snapshots.push({ ...record.payload, recordedAt: record.recordedAt, recordHash: record.hash });
      state.expected.orderId ??= record.payload.data.id;
    } else if (record.type === 'webhook_saved') state.events.push({ ...record.payload, recordedAt: record.recordedAt, recordHash: record.hash });
    else fail('CORRUPT_STORE', 'The case contains an unknown record type.');
  }
  state.latestSnapshot = state.snapshots.reduce((latest, item) => !latest || Date.parse(item.fetchedAt) > Date.parse(latest.fetchedAt) ? item : latest, null);
  return state;
}

/** Append-only local store. Directory and injected clock are trusted server configuration. */
export async function createEvidenceStore({ directory, clock = () => Date.now() }) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) fail('INVALID_DIRECTORY', 'An absolute evidence directory is required.');
  if (typeof clock !== 'function') fail('INVALID_CLOCK', 'The clock must be a function.');
  const requestedRoot = resolve(directory);
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(requestedRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail('UNSAFE_PATH', 'The evidence directory must not be a symlink.');
  const root = await realpath(requestedRoot);

  const now = () => {
    const value = clock();
    if (typeof value !== 'number' || !Number.isFinite(value)) fail('INVALID_CLOCK', 'The clock must return finite epoch milliseconds.');
    return value;
  };
  async function safeFile(path, { missing = false } = {}) {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('UNSAFE_PATH', 'Evidence files must be regular files with one link.');
      return info;
    } catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  }
  async function locked(id, operation) {
    caseKey(id);
    const file = join(root, `${id}.jsonl`);
    const prior = queues.get(file) ?? Promise.resolve();
    let release;
    const turn = new Promise(resolveTurn => { release = resolveTurn; });
    queues.set(file, turn);
    await prior;
    const lockPath = join(root, `${id}.lock`);
    let lock;
    try {
      const currentRoot = await lstat(root);
      if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink()) fail('UNSAFE_PATH', 'The evidence directory changed.');
      try { lock = await open(lockPath, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') fail('STORE_BUSY', 'The case is locked. A crashed process lock requires manual inspection before removal.'); throw error; }
      return await operation(file);
    } finally {
      try { if (lock) { await lock.close(); await unlink(lockPath); } }
      finally { release(); if (queues.get(file) === turn) queues.delete(file); }
    }
  }
  async function readRecords(file, id, allowMissing = false) {
    const info = await safeFile(file, { missing: true });
    if (!info) { if (allowMissing) return { records: [], bytes: 0 }; fail('CASE_NOT_FOUND', 'The evidence case does not exist.'); }
    if (info.size > MAX_CASE_BYTES) fail('CASE_TOO_LARGE', 'The case exceeds the 1 MB local store limit.');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let bytes;
    try { bytes = await handle.readFile(); } finally { await handle.close(); }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('CORRUPT_STORE', 'The case contains invalid UTF-8.'); }
    if (!text || !text.endsWith('\n')) fail('CORRUPT_STORE', 'The case has an incomplete final record. No records were discarded.');
    const records = [];
    let previousHash = null;
    for (const line of text.slice(0, -1).split('\n')) {
      let record;
      try { record = JSON.parse(line); } catch { fail('CORRUPT_STORE', 'The case contains invalid JSON.'); }
      if (!record || typeof record !== 'object' || Array.isArray(record)) fail('CORRUPT_STORE', 'The case contains an invalid record.');
      const { hash, ...content } = record;
      if (!HASH.test(hash ?? '') || content.version !== 1 || content.caseId !== id || content.sequence !== records.length + 1 || content.previousHash !== previousHash || digest(canonical(content)) !== hash || !Number.isFinite(Date.parse(content.recordedAt))) fail('CORRUPT_STORE', 'The case hash chain, sequence or identity is invalid.');
      if (Object.keys(content).sort().join(',') !== 'caseId,payload,previousHash,recordedAt,sequence,type,version') fail('CORRUPT_STORE', 'The record schema is invalid.');
      records.push(record);
      previousHash = hash;
    }
    return { records, bytes: bytes.length };
  }
  async function append(file, id, loaded, type, payload, time) {
    const content = { version: 1, caseId: id, sequence: loaded.records.length + 1, type, recordedAt: new Date(time).toISOString(), payload, previousHash: loaded.records.at(-1)?.hash ?? null };
    const record = { ...content, hash: digest(canonical(content)) };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) fail('RECORD_TOO_LARGE', 'The record exceeds 128 KB.');
    if (loaded.bytes + Buffer.byteLength(line) > MAX_CASE_BYTES) fail('CASE_TOO_LARGE', 'The case reached its 1 MB limit. Archive it before adding more evidence.');
    const flags = loaded.records.length ? constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
    const handle = await open(file, flags, 0o600);
    try { await handle.writeFile(line); await handle.sync(); } finally { await handle.close(); }
    return record;
  }
  async function confirmDurable(file) {
    // A prior append may have completed before its sync failed. A duplicate
    // acknowledgement must not silently turn that uncertainty into success.
    const handle = await open(file, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try { await handle.sync(); } finally { await handle.close(); }
  }
  async function mutate(id, prepare) {
    return locked(id, async file => {
      const loaded = await readRecords(file, id);
      const state = project(id, loaded.records);
      const time = now();
      const change = prepare(state, time);
      if (change.duplicate) { await confirmDurable(file); return freeze(change.result); }
      const record = await append(file, id, loaded, change.type, change.payload, time);
      return freeze({ duplicate: false, ...record.payload, recordedAt: record.recordedAt, recordHash: record.hash });
    });
  }

  return Object.freeze({
    async createCase({ caseId, expected, source }) {
      caseKey(caseId);
      const cleanExpected = jsonCopy(expected);
      validateExpected(cleanExpected);
      if (!SOURCES.has(source)) fail('INVALID_SOURCE', 'A case must declare sandbox or synthetic-fixture provenance.');
      return locked(caseId, async file => {
        const loaded = await readRecords(file, caseId, true);
        if (loaded.records.length) {
          const state = project(caseId, loaded.records);
          if (!same(loaded.records[0].payload, { expected: cleanExpected, source })) fail('CASE_CONFLICT', 'An existing case cannot be rebound to another invoice or source.');
          await confirmDurable(file);
          return freeze(state);
        }
        const record = await append(file, caseId, loaded, 'case_created', { expected: cleanExpected, source }, now());
        return freeze(project(caseId, [record]));
      });
    },
    async readCase(caseId) { return locked(caseId, async file => freeze(project(caseId, (await readRecords(file, caseId)).records))); },
    async reserveRequest(caseId, { operation, payload }) {
      const clean = jsonCopy(payload);
      if (!clean || typeof clean !== 'object' || Array.isArray(clean)) fail('INVALID_REQUEST', 'The operation payload must be a JSON object.');
      if (!['create_order', 'capture_order'].includes(operation)) fail('INVALID_OPERATION', 'Only create_order and capture_order keys can be reserved.');
      return mutate(caseId, state => {
        if (operation === 'create_order') {
          if (Object.keys(clean).sort().join(',') !== 'currencyCode,invoiceId,value' || clean.invoiceId !== state.expected.invoiceId || clean.currencyCode !== state.expected.currencyCode || toMinor(clean.value, clean.currencyCode) !== toMinor(state.expected.value, state.expected.currencyCode)) fail('REQUEST_MISMATCH', 'The creation payload must match the case invoice.');
        } else if (Object.keys(clean).join(',') !== 'orderId' || !state.expected.orderId || clean.orderId !== state.expected.orderId) fail('REQUEST_MISMATCH', 'The capture payload must reference the bound case order.');
        const existing = state.requests.find(item => item.operation === operation);
        if (existing) {
          if (!same(existing.payload, clean)) fail('IDEMPOTENCY_CONFLICT', 'The reserved operation cannot be reused with another payload.');
          return { duplicate: true, result: { duplicate: true, ...existing } };
        }
        return { type: 'request_reserved', payload: { operation, requestId: randomUUID(), payload: clean, payloadHash: digest(canonical(clean)) } };
      });
    },
    async saveSnapshot(caseId, envelope) {
      const clean = jsonCopy(envelope);
      if (!clean || typeof clean !== 'object' || Array.isArray(clean) || Object.keys(clean).some(key => !['data', 'source', 'fetchedAt', 'status', 'debugId'].includes(key))) fail('INVALID_SNAPSHOT', 'Unsupported snapshot envelope fields.');
      return mutate(caseId, (state, time) => {
        if (clean.source !== state.source || !paypalId(clean.data?.id) || !timestamp(clean.fetchedAt, time) || !Number.isInteger(clean.status) || clean.status < 200 || clean.status >= 300) fail('INVALID_SNAPSHOT', 'Snapshot source, identity, status or observation time is invalid.');
        if (state.expected.orderId && clean.data.id !== state.expected.orderId) fail('ORDER_CONFLICT', 'The case is already bound to another PayPal order.');
        const units = clean.data.purchase_units;
        if (!Array.isArray(units) || units.length !== 1 || units[0]?.invoice_id !== state.expected.invoiceId) fail('SNAPSHOT_INVOICE_MISMATCH', 'The snapshot must contain the single bound invoice.');
        const incomingCaptures = units[0].payments?.captures ?? [];
        if (!Array.isArray(incomingCaptures)) fail('INVALID_SNAPSHOT', 'The snapshot capture collection is malformed.');
        const known = new Map();
        const inSnapshot = new Map();
        for (const snapshot of state.snapshots) for (const cap of snapshot.data.purchase_units[0].payments?.captures ?? []) known.set(cap.id, captureIdentity(cap));
        for (const cap of incomingCaptures) {
          if (!paypalId(cap?.id)) fail('INVALID_CAPTURE', 'Capture IDs must be valid and stable.');
          if (inSnapshot.has(cap.id) && !same(inSnapshot.get(cap.id), cap)) fail('CAPTURE_CONFLICT', 'A snapshot contains conflicting copies of one capture ID.');
          inSnapshot.set(cap.id, cap);
          const identity = captureIdentity(cap);
          if (known.has(cap.id) && !same(known.get(cap.id), identity)) fail('CAPTURE_CONFLICT', 'A capture ID cannot be associated with a different amount or invoice.');
          known.set(cap.id, identity);
        }
        const existing = state.snapshots.find(item => Date.parse(item.fetchedAt) === Date.parse(clean.fetchedAt));
        if (existing) {
          const { recordHash, recordedAt, ...original } = existing;
          if (!same(original, { ...clean, fetchedAt: existing.fetchedAt })) fail('SNAPSHOT_CONFLICT', 'One snapshot observation time cannot identify different payloads.');
          return { duplicate: true, result: { duplicate: true, ...existing } };
        }
        return { type: 'snapshot_saved', payload: clean };
      });
    },
    async saveVerifiedWebhook(caseId, envelope) {
      const clean = jsonCopy(envelope);
      if (!clean || typeof clean !== 'object' || Array.isArray(clean) || Object.keys(clean).sort().join(',') !== 'event,receivedAt,source,verification') fail('INVALID_WEBHOOK', 'Use the unmodified verified webhook envelope.');
      return mutate(caseId, (state, time) => {
        const verification = clean.verification;
        const expectedMethod = state.source === 'paypal-sandbox' ? 'paypal-postback' : 'fixture-assertion-not-cryptographic';
        if (clean.source !== state.source || verification?.status !== 'SUCCESS' || verification.method !== expectedMethod || !timestamp(clean.receivedAt, time) || !timestamp(verification.checkedAt, time) || !paypalId(clean.event?.id) || typeof clean.event.event_type !== 'string' || !clean.event.event_type || !timestamp(clean.event.create_time, Date.parse(verification.checkedAt))) fail('UNVERIFIED_WEBHOOK', 'Only a successful verification with matching source and original timestamps can be stored.');
        const eventOrder = clean.event.event_type?.startsWith('CHECKOUT.ORDER.') ? clean.event.resource?.id : clean.event.resource?.supplementary_data?.related_ids?.order_id;
        const captureId = relatedCaptureId(clean.event.resource);
        const captures = state.snapshots.flatMap(snapshot => snapshot.data.purchase_units[0].payments?.captures ?? []);
        if (eventOrder ? eventOrder !== state.expected.orderId : !captures.some(cap => cap.id === captureId)) fail('WEBHOOK_UNLINKED', 'The event must link to the bound order or a captured payment in its saved snapshots.');
        const existing = state.events.find(item => item.event.id === clean.event.id);
        if (existing) {
          if (!same(existing.event, clean.event)) fail('EVENT_CONFLICT', 'A stored event ID cannot identify different event contents.');
          return { duplicate: true, result: { duplicate: true, ...existing } };
        }
        return { type: 'webhook_saved', payload: clean };
      });
    },
    async replayEvents(caseId, { copies = 2 } = {}) {
      if (!Number.isInteger(copies) || copies < 1 || copies > 10) fail('INVALID_REPLAY', 'Replay copies must be an integer from one to ten.');
      return locked(caseId, async file => {
        const state = project(caseId, (await readRecords(file, caseId)).records);
        const events = state.events.flatMap(({ recordHash, recordedAt, ...original }) => Array.from({ length: copies }, (_, index) => ({ ...structuredClone(original), replay: { originalRecordHash: recordHash, originallyStoredAt: recordedAt, copyIndex: index + 1, totalCopies: copies } })));
        return freeze({ events, provenance: { kind: 'stored-replay', source: state.source, notice: 'Replay of saved verified JSON; original source and timestamps are preserved. No new PayPal delivery or verification occurred.' } });
      });
    }
  });
}
