import { toMinor } from './money.js';

export const PAYPAL_SANDBOX_ORIGIN = 'https://api-m.sandbox.paypal.com';

export class PayPalError extends Error {
  constructor(code, { status = null, debugId = null, outcome = 'not-attempted' } = {}) {
    super(`PayPal sandbox request failed: ${code}`);
    this.name = 'PayPalError';
    this.code = code;
    this.status = status;
    this.debugId = debugId;
    this.outcome = outcome;
  }
}

const required = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`${name} is required and must be at most ${max} characters.`);
  return value;
};
const resourceId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(value)) throw new TypeError('Invalid PayPal resource ID.');
  return value;
};
const requestId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]{1,38}$/.test(value)) throw new TypeError('A stable requestId of 1–38 ASCII letters, digits or hyphens is required.');
  return value;
};
const freezeTree = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freezeTree(item); Object.freeze(value); }
  return value;
};

/** Explicitly sandbox-only. No public arbitrary URL/request method is exposed. */
export function createPayPalSandboxClient({ clientId, clientSecret, webhookId, fetchImpl = globalThis.fetch, timeoutMs = 15000, now = () => Date.now(), baseUrl = PAYPAL_SANDBOX_ORIGIN }) {
  if (baseUrl !== PAYPAL_SANDBOX_ORIGIN) throw new TypeError('Only the fixed PayPal sandbox origin is allowed.');
  required(clientId, 'clientId', 500);
  required(clientSecret, 'clientSecret', 500);
  if (typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('A fetch implementation and positive timeout are required.');
  let token;
  let expiresAt = 0;
  let tokenPromise;
  // This prevents accidental key reuse in one process. Persist keys at the application layer before mutating.
  const mutations = new Map();

  async function exchange(path, { method = 'GET', body, headers = {}, mutating = false } = {}) {
    let response;
    try {
      response = await fetchImpl(`${PAYPAL_SANDBOX_ORIGIN}${path}`, {
        method, headers: { Accept: 'application/json', ...headers }, body,
        signal: AbortSignal.timeout(timeoutMs), redirect: 'error'
      });
    } catch {
      throw new PayPalError('NETWORK_OR_TIMEOUT', { outcome: mutating ? 'unknown' : 'not-attempted' });
    }
    let data;
    try { data = await response.json(); }
    catch { throw new PayPalError('INVALID_JSON_RESPONSE', { status: response.status, outcome: mutating ? 'unknown' : 'not-attempted' }); }
    if (!response.ok) {
      // Never copy arbitrary response bodies, tokens or request headers into errors.
      const code = typeof data.name === 'string' && /^[A-Z_]{1,80}$/.test(data.name) ? data.name : `HTTP_${response.status}`;
      const rawDebugId = response.headers.get('paypal-debug-id') ?? data.debug_id;
      const debugId = typeof rawDebugId === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(rawDebugId) ? rawDebugId : null;
      throw new PayPalError(code, { status: response.status, debugId, outcome: mutating ? 'unknown' : 'not-attempted' });
    }
    return { data, status: response.status, debugId: response.headers.get('paypal-debug-id'), source: 'paypal-sandbox', fetchedAt: new Date(now()).toISOString() };
  }

  async function accessToken() {
    if (token && now() < expiresAt) return token;
    if (tokenPromise) return tokenPromise;
    tokenPromise = (async () => {
      const result = await exchange('/v1/oauth2/token', {
        method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials'
      });
      if (typeof result.data.access_token !== 'string' || !result.data.access_token || !Number.isFinite(result.data.expires_in) || result.data.expires_in <= 0) throw new PayPalError('INVALID_TOKEN_RESPONSE');
      token = result.data.access_token;
      expiresAt = now() + Math.max(0, result.data.expires_in * 1000 - 30000);
      return token;
    })();
    try { return await tokenPromise; } finally { tokenPromise = null; }
  }

  async function request(path, { method = 'GET', data, id } = {}) {
    const body = data === undefined ? undefined : JSON.stringify(data);
    if (id) {
      requestId(id);
      const fingerprint = `${method} ${path} ${body ?? ''}`;
      if (mutations.has(id) && mutations.get(id) !== fingerprint) throw new TypeError('requestId was already used for a different operation or payload.');
      mutations.set(id, fingerprint);
    }
    const bearer = await accessToken();
    try {
      return await exchange(path, {
        method, body, mutating: !!id,
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...(id ? { 'PayPal-Request-Id': id, Prefer: 'return=representation' } : {}) }
      });
    } catch (error) {
      if (error.status === 401) { token = undefined; expiresAt = 0; }
      throw error; // No hidden mutation retry. Caller reconciles an unknown outcome first.
    }
  }

  return Object.freeze({
    environment: 'sandbox',
    async createOrder({ invoiceId, value, currencyCode = 'USD', requestId: id }) {
      required(invoiceId, 'invoiceId', 127);
      if (toMinor(value, currencyCode) <= 0n) throw new TypeError('Order value must be positive.');
      requestId(id);
      return request('/v2/checkout/orders', { method: 'POST', id, data: { intent: 'CAPTURE', purchase_units: [{ invoice_id: invoiceId, amount: { currency_code: currencyCode, value } }] } });
    },
    getOrder(id) { return request(`/v2/checkout/orders/${resourceId(id)}`); },
    getCapture(id) { return request(`/v2/payments/captures/${resourceId(id)}`); },
    captureOrder(id, { requestId: key } = {}) {
      requestId(key);
      return request(`/v2/checkout/orders/${resourceId(id)}/capture`, { method: 'POST', id: key, data: {} });
    },
    async verifyWebhook({ headers, event }) {
      required(webhookId, 'webhookId', 50);
      if (!event || typeof event !== 'object' || Array.isArray(event) || !event.id) throw new TypeError('Webhook event is required.');
      // Preserve exactly the JSON sent for verification; do not return the caller's mutable object.
      const verifiedEvent = JSON.parse(JSON.stringify(event));
      const incoming = new Headers(headers);
      const fields = { auth_algo: 'paypal-auth-algo', cert_url: 'paypal-cert-url', transmission_id: 'paypal-transmission-id', transmission_sig: 'paypal-transmission-sig', transmission_time: 'paypal-transmission-time' };
      const data = { webhook_id: webhookId, webhook_event: verifiedEvent };
      for (const [field, header] of Object.entries(fields)) data[field] = required(incoming.get(header), header, 1000);
      // The configured webhook ID is never taken from incoming JSON or headers.
      const result = await request('/v1/notifications/verify-webhook-signature', { method: 'POST', data });
      const status = result.data.verification_status === 'SUCCESS' ? 'SUCCESS' : 'FAILURE';
      return freezeTree({ event: verifiedEvent, source: 'paypal-sandbox', receivedAt: result.fetchedAt, verification: { status, method: 'paypal-postback', checkedAt: result.fetchedAt } });
    }
  });
}
