import { createPayPalSandboxClient } from './paypal.js';
import { reconcileCase } from './reconcile.js';

const RETRY_WINDOW_MS = 15 * 60 * 1000;
export class SandboxWorkflowError extends Error {
  constructor(code, message, { outcome = 'not-attempted', requestId = null } = {}) {
    super(message); this.name = 'SandboxWorkflowError'; this.code = code; this.outcome = outcome; this.requestId = requestId;
  }
}
const fail = (code, message, details) => { throw new SandboxWorkflowError(code, message, details); };

/** Server/CLI workflow. An injected client factory always produces fixture provenance. */
export function createSandboxWorkflow({ store, env = {}, clientFactory, clock = () => Date.now() }) {
  if (!store || !['createCase', 'readCase', 'reserveRequest', 'saveSnapshot'].every(key => typeof store[key] === 'function')) throw new TypeError('An evidence store is required.');
  if (typeof clock !== 'function') throw new TypeError('A clock function is required.');
  const source = clientFactory ? 'synthetic-fixture' : 'paypal-sandbox';
  let client;
  const now = () => {
    const value = clock();
    if (!Number.isFinite(value)) fail('INVALID_CLOCK', 'The workflow clock is invalid.');
    return value;
  };
  function getClient() {
    if (client) return client;
    if (![env.PAYPAL_CLIENT_ID, env.PAYPAL_CLIENT_SECRET].every(value => typeof value === 'string' && value.trim())) fail('SANDBOX_NOT_CONFIGURED', 'Server-side PayPal sandbox credentials are required.');
    client = (clientFactory ?? createPayPalSandboxClient)({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, now, timeoutMs: 15000 });
    if (client?.environment !== 'sandbox' || !['createOrder', 'getOrder', 'captureOrder'].every(key => typeof client[key] === 'function')) fail('INVALID_CLIENT', 'A sandbox-only payment adapter is required.');
    return client;
  }
  function checkSource(state) {
    if (state.source !== source) fail('SOURCE_MISMATCH', 'This workflow cannot mix synthetic and sandbox evidence.');
  }
  function checkRetry(reservation) {
    const age = now() - Date.parse(reservation.recordedAt);
    if (!Number.isFinite(age) || age < 0 || age > RETRY_WINDOW_MS) fail('RETRY_WINDOW_EXPIRED', 'This local retry window expired. Inspect the existing order and original request before further action; no new key was created.', { outcome: 'unknown', requestId: reservation.requestId });
  }
  function normalize(envelope, orderId) {
    if (!envelope || envelope.source !== 'paypal-sandbox' || !Number.isInteger(envelope.status) || envelope.status < 200 || envelope.status >= 300 || typeof envelope.data?.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(envelope.data.id) || (orderId && envelope.data.id !== orderId)) fail('INVALID_PROVIDER_RESPONSE', 'The adapter returned invalid or mismatched sandbox evidence.', { outcome: 'unknown' });
    // Preserve all original response data privately. Only the provenance changes for injected tests.
    return { data: envelope.data, source, status: envelope.status, fetchedAt: envelope.fetchedAt, ...(envelope.debugId === undefined ? {} : { debugId: envelope.debugId }) };
  }
  function reconcileState(state) {
    if (!state.expected.orderId || !state.latestSnapshot) return null;
    return reconcileCase({ expected: state.expected, order: state.latestSnapshot, events: state.events, observedAt: new Date(now()).toISOString() });
  }
  function view(state, { operation = 'reconcile', disposition = 'stored-evidence', requestId = null } = {}) {
    const hasProviderEvidence = state.snapshots.length > 0 || state.events.length > 0;
    const approvalLinkAvailable = Array.isArray(state.latestSnapshot?.data.links) && state.latestSnapshot.data.links.some(link => {
      if (!['approve', 'payer-action'].includes(link?.rel) || typeof link.href !== 'string') return false;
      try { const url = new URL(link.href); return url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com' && !url.username && !url.password; } catch { return false; }
    });
    return {
      caseId: state.caseId, operation, disposition, orderId: state.expected.orderId ?? null, requestId,
      result: reconcileState(state), approvalLinkAvailable,
      provenance: {
        kind: hasProviderEvidence ? state.source : 'no-provider-evidence', configuredSource: state.source,
        notice: !hasProviderEvidence ? 'Only local case/request records exist. No provider response or verified event has been stored.' : state.source === 'synthetic-fixture' ? 'Injected adapter fixture; no authentic PayPal request is demonstrated.' : 'Stored PayPal sandbox evidence. Fictitious funds only; this is not a bank-settlement confirmation.'
      },
      receipt: { recordCount: state.records.length, latestRecordHash: state.records.at(-1).hash, latestObservedAt: state.latestSnapshot?.fetchedAt ?? null }
    };
  }
  async function refresh(caseId) {
    const state = await store.readCase(caseId);
    checkSource(state);
    if (!state.expected.orderId) fail('ORDER_NOT_BOUND', 'No order ID is saved. Resolve the original create request before reading or capturing.');
    let response;
    try { response = await getClient().getOrder(state.expected.orderId); }
    catch (error) {
      if (error instanceof SandboxWorkflowError) throw error;
      fail('PAYPAL_READ_FAILED', 'The sandbox read failed. Stored evidence was not replaced.');
    }
    await store.saveSnapshot(caseId, normalize(response, state.expected.orderId));
    return store.readCase(caseId);
  }
  return Object.freeze({
    async create({ caseId, invoiceId, value, currencyCode = 'USD', retryCreate = false }) {
      const api = getClient();
      const state = await store.createCase({ caseId, expected: { invoiceId, value, currencyCode }, source });
      checkSource(state);
      if (state.expected.orderId) return view(await refresh(caseId), { operation: 'create', disposition: 'existing-order-refreshed' });
      const reservation = await store.reserveRequest(caseId, { operation: 'create_order', payload: { invoiceId, value, currencyCode } });
      if (reservation.duplicate) {
        if (retryCreate !== true) fail('CREATE_RETRY_REQUIRED', 'A create request is already reserved and its outcome may be unknown. Inspect the sandbox first, then explicitly retry the same request if appropriate.', { outcome: 'unknown', requestId: reservation.requestId });
        checkRetry(reservation);
      }
      let response;
      try { response = await api.createOrder({ ...reservation.payload, requestId: reservation.requestId }); }
      catch { fail('PAYPAL_CREATE_UNKNOWN', 'The create outcome is unknown. Its durable request key is retained; no automatic retry occurred.', { outcome: 'unknown', requestId: reservation.requestId }); }
      try { await store.saveSnapshot(caseId, normalize(response)); }
      catch { fail('CREATE_RECEIPT_NOT_SAVED', 'PayPal returned a response but its receipt was not saved. Preserve the original request key and resolve the order before retrying.', { outcome: 'unknown', requestId: reservation.requestId }); }
      let refreshed;
      try { refreshed = await refresh(caseId); }
      catch { fail('POST_CREATE_READ_FAILED', 'The create receipt was saved, but its follow-up read failed. Re-run read for this case; do not create a new order.', { outcome: 'unknown', requestId: reservation.requestId }); }
      return view(refreshed, { operation: 'create', disposition: reservation.duplicate ? 'same-create-request-retried' : 'created-and-read', requestId: reservation.requestId });
    },
    async read(caseId) { return view(await refresh(caseId), { operation: 'read', disposition: 'fresh-sandbox-read' }); },
    async capture(caseId, { confirmCapture = false } = {}) {
      if (confirmCapture !== true) fail('CAPTURE_CONFIRMATION_REQUIRED', 'Capture requires an explicit operator decision. No payment request was sent.');
      const state = await refresh(caseId);
      const decision = reconcileState(state);
      if (decision?.state !== 'ready_to_capture' || !decision.allowedActions.includes('capture_order')) {
        return view(state, { operation: 'capture', disposition: 'capture-not-sent' });
      }
      const reservation = await store.reserveRequest(caseId, { operation: 'capture_order', payload: { orderId: state.expected.orderId } });
      if (reservation.duplicate) checkRetry(reservation);
      let response;
      try { response = await getClient().captureOrder(state.expected.orderId, { requestId: reservation.requestId }); }
      catch { fail('PAYPAL_CAPTURE_UNKNOWN', 'The capture outcome is unknown. Its durable key is retained. The next capture command will read and reconcile the order before considering the same key.', { outcome: 'unknown', requestId: reservation.requestId }); }
      try { await store.saveSnapshot(caseId, normalize(response, state.expected.orderId)); }
      catch { fail('CAPTURE_RECEIPT_NOT_SAVED', 'PayPal returned a capture response but its receipt was not saved. Read the order before further action; do not create a new key.', { outcome: 'unknown', requestId: reservation.requestId }); }
      let refreshed;
      try { refreshed = await refresh(caseId); }
      catch { fail('POST_CAPTURE_READ_FAILED', 'The capture receipt was saved, but its follow-up read failed. Read and reconcile this case before further payment action.', { outcome: 'unknown', requestId: reservation.requestId }); }
      return view(refreshed, { operation: 'capture', disposition: reservation.duplicate ? 'same-capture-request-retried' : 'capture-response-saved-and-read', requestId: reservation.requestId });
    },
    async reconcile(caseId) { return view(await store.readCase(caseId)); },
    async exportCase(caseId) {
      const state = await store.readCase(caseId);
      return {
        schemaVersion: '1.0', exportedAt: new Date(now()).toISOString(), ...view(state, { operation: 'export' }),
        records: state.records.map(({ sequence, type, recordedAt, hash }) => ({ sequence, type, recordedAt, hash })),
        requests: state.requests.map(({ operation, requestId, payloadHash, recordedAt }) => ({ operation, requestId, payloadHash, recordedAt })),
        privacyNotice: 'This minimized export excludes raw PayPal responses, payer details, approval links and authentication material. Private store records contain original provider JSON.'
      };
    }
  });
}
