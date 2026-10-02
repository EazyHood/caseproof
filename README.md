# Caseproof

A small PayPal **sandbox-only** reconciliation core for answering: “Was this invoice captured once, and what evidence supports the next action?”

**Current evidence: two authentic PayPal sandbox orders were captured for 49.00 USD each in fictitious funds; a genuine capture webhook was received and verified through PayPal's postback API.** The first order's [saved timeline](./evidence/exports/sandbox-001-timeline.json) records CREATED → APPROVED → COMPLETED, and its [recorded local-model response](./evidence/exports/sandbox-001-local-ai.json) uses a fresh sandbox read. The second order's [minimized export](./evidence/exports/cp-live-sandbox-002-1790916633232-2b97bef0.json) includes the verified event. A [labeled local replay](./evidence/exports/sandbox-002-verified-replay.json) supplies that saved event twice and still counts 49.00 USD once; it is not evidence of two network deliveries. Three saved evaluations contain another 18 local model responses on synthetic cases. The coordinator's full test run passed **126/126** on 2 October 2026 at approximately 04:50 UTC. This is a local prototype; no public deployment or project submission is recorded. See [BRIEF.md](./BRIEF.md) and [VALIDATION.md](./VALIDATION.md).

## Run without accounts or packages

Requires Node.js 22 or later; tested with Node 24.16.0. The deterministic demo has zero npm dependencies and no package-install step. Optional model inference requires a separately installed local runtime and model.

```sh
node --test
node src/demo.js
```

The demo runs six hand-authored cases, prints the decision and remains offline. `fixtures/cases.js` labels its data as synthetic; it is not a replay of a PayPal execution. `npm test` and `npm run demo` are equivalent convenience commands.

## Static preview

`node scripts/build-static.mjs` builds `dist/` from an explicit 12-file allowlist: the interface, public configuration, local-run instructions, six precomputed synthetic scenarios and a minimized record of the first authentic sandbox capture. It does not copy credentials, private evidence or temporary artifacts. To include the source link, pass `--repository` with the actual HTTPS GitHub repository URL. The current unconfigured preview does not invent that link.

Serve `dist/` with a static web server or publish that directory through a static host. Its **Offline demo / synthetic scenarios** banner distinguishes the scenarios from the separate historical sandbox record. PayPal inspection and local inference are disabled; opening the preview makes no PayPal or model calls and does not refresh the recorded evidence. The local app below enables those services when configured. Building this directory does not deploy it.

## Local HTTP server

```sh
npm start
# Or: node server.mjs
```

Open `http://127.0.0.1:5189`. The server binds only to IPv4 loopback, serves the fixed files in `public/`, and exposes six synthetic cases. `GET /api/config` reports configuration presence, not proven service connectivity. `GET /api/cases` lists cases; `GET /api/cases/:id` returns a freshly computed result and its synthetic provenance.

`POST /api/analyze` takes exactly one selector: `{ "caseId": "duplicate-webhook" }` for a synthetic case or `{ "resultId": "..." }` for a prior inspection. Mixed selectors, client-supplied results and extra fields are rejected. It requires `CASEPROOF_OLLAMA_MODEL` to name an available local model; absent configuration returns HTTP 503 without fabricated inference. For an inspection, the server fetches the bound order again using its own credentials and recomputes the result before asking the model. The response includes that current `result`, `proposal`, `validation` and provenance; the UI updates the ledger from the same result the model received.

The UI keeps calculated amounts and state visible. Model prose is collapsed under **“Read the unverified model explanation”**, with a warning that it may contradict the evidence or describe actions that have not happened. “Structured checks passed” does not certify the explanation.

`POST /api/inspect` takes exactly `{ "orderId": "...", "invoiceId": "...", "value": "49.00", "currencyCode": "USD" }`. It requires server-side `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`, fetches that order through `getOrder` only, and returns a minimized reconciliation result, an opaque `resultId` and `resultExpiresAt`. Inspection IDs last five minutes, are local to one server process and are limited to 128 contexts. The memory cache retains only the validated expected invoice and expiry, not provider responses, payer details or credentials. An expired or unavailable ID requires another inspection. This HTTP server has no create, capture or refund endpoint. Configuration can be loaded explicitly with `node --env-file=.env server.mjs`; the ordinary command does not automatically load a file.

Both POST routes require `Content-Type: application/json`, a body of at most 16 KB and an `Origin` header exactly matching the local HTTP host and port. Browser requests from this page provide it automatically. Host validation blocks non-loopback hostnames and mismatched ports; there is no CORS allowance. Errors use `{ "error": { "code": "...", "message": "..." } }` without raw upstream errors or credentials. Client disconnection aborts in-flight default network requests; body and upstream operations have bounded timeouts.

`createCaseproofServer({ env = {}, clientFactory?, generateFactory?, clock? })` is exported for tests. Imported instances do not read ambient credentials. Any injected payment client is always labeled as synthetic evidence, even if it returns a sandbox-looking envelope; an injected generator is labeled `injected-test-generator`. These test seams cannot establish an authentic integration. `tests/server.test.mjs` uses real local HTTP requests and simulated upstreams, and makes no PayPal or model calls.

## Stable module contract

```js
import { reconcileCase, validateProposal } from './src/index.js';
import { fixtureCase } from './fixtures/cases.js';

const input = fixtureCase('duplicate-webhook');
const result = reconcileCase(input);
// result.state === 'paid'
// result.amounts.completedMinor === '4900'
// result.duplicateEvents === 1
// result.mode === 'fixture'
```

`reconcileCase` is pure and requires:

```js
{
  expected: { orderId, invoiceId, value: '49.00', currencyCode: 'USD' },
  order: {
    data: paypalOrderJson,
    source: 'paypal-sandbox', // assigned by your trusted server, never a browser claim
    fetchedAt: '2026-10-02T05:00:10Z'
  },
  events: [{
    event: paypalWebhookJson,
    source: 'paypal-sandbox',
    verification: { status: 'SUCCESS' } // only after verifier success
  }],
  observedAt: '2026-10-02T05:00:20Z',
  maxSnapshotAgeMs: 300000 // optional, default five minutes
}
```

Return shape: `{schemaVersion, orderId, invoiceId, observedAt, mode, state, allowedActions, issues, evidence, duplicateEvents, amounts, execution}`. Amounts use decimal strings and minor-unit integer strings, avoiding JSON BigInt and floating-point rounding. Evidence has `{id, kind, label, facts}`; issues have `{code, message, severity, evidenceIds}`. `allowedActions` proposes the next step; nothing executes.

| State | What it means | Proposed next step |
|---|---|---|
| `paid` | Current unique COMPLETED captures equal the expected invoice | `record_payment` |
| `ready_to_capture` | Matching fresh APPROVED order has no capture records | `capture_order` |
| `awaiting_approval` | Matching order still requires buyer approval | `request_approval` |
| `pending` | At least one capture remains PENDING | `wait`, `refresh_order` |
| `underpaid` / `overpaid` | Completed captures differ from expectation | Refresh/review as returned |
| `review_required` | Stale, inconsistent, refunded, unsupported or incomplete evidence | Refresh/manual review as returned |
| `unknown` | No order snapshot | `refresh_order` |

Only current captures in the order snapshot contribute to the amount. A webhook is a consistency signal, never a second payment. Signature verification is distinct from reconciliation: this pure function trusts its server-side input. A `SUCCESS` string supplied by a client is not proof of authenticity. Dedupe inside this function is per reconciliation call; the separate evidence store supplies persistence.

## PayPal adapter

Keep credentials on the server. `createPayPalSandboxClient({clientId, clientSecret, webhookId?})` exposes:

```js
await client.createOrder({ invoiceId, value: '49.00', currencyCode: 'USD', requestId });
await client.getOrder(orderId);
await client.captureOrder(orderId, { requestId });
await client.getCapture(captureId);
await client.verifyWebhook({ headers, event });
```

Order/capture methods return `{data, status, debugId, source:'paypal-sandbox', fetchedAt}`. The verifier returns an event envelope with `verification.status` of `SUCCESS` or `FAILURE`. It uses the configured webhook ID and the original event content; never modify the event before verifying. Only store/use a verified envelope after success. PayPal's simulator events do not support this postback method.

The only allowed origin is `https://api-m.sandbox.paypal.com`. Redirects are rejected. A mutation requires an explicit request ID; creation and capture need different keys. Persist each key before the request and reuse it only for the exact operation/body when appropriate. A transport error or unsuccessful mutation has `error.outcome === 'unknown'`: read the order before deciding whether to retry. There is no hidden retry. The adapter prevents key reuse for differing payloads during one process, but does not provide durable idempotency across restarts.

`node src/inspect-sandbox.js` is an explicit read-only check using the environment names in `.env.example`. It fetches one existing order and prints a minimized reconciliation result. No credentials are embedded or loaded automatically. If you use a local `.env`, Node supports `node --env-file=.env src/inspect-sandbox.js`; keep that file untracked. Recorded authentic sandbox results are described in [VALIDATION.md](./VALIDATION.md).

Before exposing a mutation endpoint, add authentication, order ownership checks, request/body validation and an explicit operator action after a fresh reconciliation, using the persistent request keys below. Do not expose the low-level client directly to the browser. The separate [webhook receiver](./WEBHOOK-RECEIVER.md) has now received and stored a genuine sandbox event after successful postback verification; its controlled demonstration is not a production hosting service.

## Persistent evidence and sandbox workflow

`src/evidence-store.js` is implemented and independently reviewed. It stores immutable case identity, separate create/capture request UUIDs, original snapshots and verified-event envelopes in append-only hash-chained JSONL. Identical retries retain the same record and require a successful file sync before acknowledgement. Replay retains original provenance and timestamps. This is a private local store, not a cryptographic attestation of PayPal data. See [EVIDENCE-STORE.md](./EVIDENCE-STORE.md) for its corruption, locking and filesystem limits.

`scripts/sandbox.mjs` and `src/sandbox-workflow.js` connect that store to explicit sandbox create/read/capture operations and offline reconciliation/export. The CLI is implemented and independently reviewed; its automated provider tests use injected clients. The authentic sandbox run is recorded separately. Network commands require `--run`, and capture additionally requires `--confirm-capture` plus a fresh deterministic check. See [SANDBOX-WORKFLOW.md](./SANDBOX-WORKFLOW.md) for the commands and uncertain-outcome rules. The HTTP UI does not expose these mutations.

## AI proposal interface

`proposeCase(result, generate)` passes `{messages, schema}` to an explicitly supplied model function and returns `{proposal, validation}`. No default fake model exists. A local Ollama connector is provided for an **already available** model:

```js
import { createOllamaGenerator, proposeCase } from './src/index.js';
const generate = createOllamaGenerator({ model: 'your-already-installed-model' });
const { proposal, validation } = await proposeCase(result, generate);
```

The connector only contacts an HTTP loopback origin, does not itself install or download anything, and requests schema-based JSON. Service errors remain errors; invalid model JSON is rejected. `proposalSchemaFor(result)` constrains decoding to the current case's allowed actions, observed state/amount/currency and available evidence/reason IDs. Independent validation still checks the returned output.

The development environment now has Ollama **0.32.1** and the official **`qwen3:4b-instruct-2507-q4_K_M`** model (approximately 2.5 GB; download SHA-checked). Three saved six-case runs produced **3/6**, **4/6** and **6/6** structurally accepted proposals, respectively: baseline, clarified current-state prompt, then case-specific decoding constraints. These are 18 actual local model responses on hand-authored fixtures, not PayPal transactions or a general-accuracy benchmark. Earlier failures remain saved. [VALIDATION.md](./VALIDATION.md) links each report and records surviving prose errors.

Proposal schema:

```js
{
  action: 'record_payment',
  claimedState: 'paid',
  claimedCompletedMinor: '4900',
  currencyCode: 'USD',
  evidenceIds: ['expected', 'order:FIXTURE-ORDER-001', 'capture:FIXTURE-CAPTURE-001'],
  reasonCodes: ['state:paid'],
  explanation: 'AI draft explaining the cited evidence.'
}
```

`validateProposal` rejects unsupported actions, wrong amounts/currency/state, nonexistent citations/reasons, missing key payment citations and unknown fields. It does **not** prove that the explanation text is true: `explanationVerified` is always `false`, even for accepted structured assertions. Render prose as an AI draft, escape any displayed content, and never use it as an executable instruction. No proposal function calls the PayPal adapter.

## Boundaries and next evidence

One invoice/order/purchase unit, CAPTURE intent, USD/EUR/GBP. Fees, refunds, chargebacks, bank settlement, split orders, multi-party payments and production payments are not calculated. Refund/reversal evidence routes to review. No SLA, security audit, user adoption, measured savings or payment certainty beyond the inspected snapshot is claimed.

To finish the submission: record a complete demonstration, publish an accessible repository and a public or unlisted YouTube video under three minutes, and complete the project fields. Broader semantic evaluation, user validation and production hardening remain open. The genuine webhook, labeled local replay and integrated test run are recorded in [VALIDATION.md](./VALIDATION.md).

PayPal hackathon registration is confirmed. The Caseproof Devpost draft (`1209870-caseproof`) exists at step **2/5**; the project submission has **not** been sent. Registration and a saved draft are not evidence of a completed entry or a PayPal integration.

## License

Caseproof's original code is available under the [MIT License](./LICENSE), copyright 2026 Jhonatan del Rio Mejia. Local model weights are not distributed in this repository. Credentials, private provider evidence, temporary artifacts and logs are excluded from version control; the linked minimized exports and labeled evaluations are separate review artifacts.
