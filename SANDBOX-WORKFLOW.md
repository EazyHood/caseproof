# Sandbox workflow CLI

Implemented and exercised against the real PayPal **sandbox** in two recorded cases, each with a completed 49.00 USD capture in fictitious funds. Automated tests still use injected clients and are labeled separately. The commands below contact the sandbox only when deliberately invoked with configured credentials. No production origin or live-money command exists.

The CLI is `scripts/sandbox.mjs`; the reusable orchestration module is `src/sandbox-workflow.js`. It uses the existing PayPal adapter and append-only evidence store without changing the web server, UI or their contracts.

## Recorded integration evidence

- Case `cp-live-sandbox-001`: order `63W11482XV2348118`, capture `4D1364913R338640H`, 49.00 USD. Its [timeline](./evidence/exports/sandbox-001-timeline.json) preserves CREATED → APPROVED → COMPLETED and the follow-up GET; its [export](./evidence/exports/cp-live-sandbox-001-1790916352260-2e56d58c.json) records nine stored receipts. Buyer approval occurred through PayPal's sandbox interface.
- Case `cp-live-sandbox-002`: order `95540662N9576413K`, capture `2UP821765V0648713`, 49.00 USD. Its [export](./evidence/exports/cp-live-sandbox-002-1790916633232-2b97bef0.json) includes a genuine `PAYMENT.CAPTURE.COMPLETED` webhook stored by the separate receiver after SUCCESS via PayPal postback at `2026-10-02T04:49:13.369Z`.
- The second case's [replay](./evidence/exports/sandbox-002-verified-replay.json) uses two local copies of that one saved event. Completed funds remain 49.00 USD and one duplicate is excluded. It does not demonstrate a second network delivery or another signature verification.

These artifacts describe historical sandbox observations. They contain no real-money settlement or accounting execution, and opening/exporting them does not refresh PayPal state. See [VALIDATION.md](./VALIDATION.md) for timestamps and limits.

## Configuration and commands

Use Node 22 or newer. No packages are installed. `node scripts/sandbox.mjs` prints help and performs no action. Keep `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in the server process environment or an ignored `.env` file; do not put secrets in command-line flags or chat. The examples use Node's explicit env-file loader.

```sh
# Create one sandbox order for one invoice, then read and save its state.
node --env-file=.env scripts/sandbox.mjs create --case cp-1042 --invoice CP-1042 --value 49.00 --currency USD --run

# After the sandbox buyer approves the order:
node --env-file=.env scripts/sandbox.mjs read --case cp-1042 --run

# An explicit operator decision, followed by a fresh read and deterministic check:
node --env-file=.env scripts/sandbox.mjs capture --case cp-1042 --confirm-capture --run

# These commands work offline, using only previously saved evidence:
node scripts/sandbox.mjs reconcile --case cp-1042
node scripts/sandbox.mjs export --case cp-1042
```

Network commands require `--run`. Capture additionally requires `--confirm-capture`. The explicit flag is necessary but not sufficient: the workflow fetches the current order, saves its snapshot, and requires `ready_to_capture` plus `capture_order` from the deterministic engine. Paid, pending, refunded, mismatched or otherwise uncertain cases return `capture-not-sent`. A permitted capture uses its durable UUID, saves the response, and reads the order again.

The default store is `evidence/private/sandbox-cases/`, already excluded from Git. `--store ABSOLUTE_PATH` selects another server-owned private directory. Exports are new files in `evidence/exports/`; filenames include a timestamp and random suffix and existing files are never overwritten.

## Buyer approval

The CLI reports the order ID and `approvalLinkAvailable`, but does not print a PayPal approval link, query token or payer data. The original sandbox approval/payer-action link remains in the **private** saved snapshot. A trusted backend/UI can retrieve that link from `readCase(caseId).latestSnapshot.data.links` and open it for the sandbox buyer after checking that it is HTTPS on `www.sandbox.paypal.com`.

Buyer approval is a separate human/browser step. This CLI does not impersonate the buyer, approve on their behalf or claim that creating an order means payment occurred.

## Uncertain outcomes and retries

The store writes and syncs a UUID reservation before create or capture is invoked. Creation and capture have separate keys. No operation retries automatically, and no timeout rotates a key.

If creation has a saved order ID, rerunning `create` only refreshes that existing order. If a previous create reservation exists without an order ID, the default command stops with `CREATE_RETRY_REQUIRED`: the earlier request may have succeeded. Inspect the sandbox before deciding to retry. If retrying is appropriate, repeat the exact creation command with `--retry-create`; it uses the original UUID and exact payload.

If capture times out, running the same explicit capture command performs a fresh read first. When the prior capture actually completed, the engine sees the captured funds and sends no further capture. If the order is still capture-ready, the original capture UUID is reused. A successful mutation whose receipt or follow-up read fails is reported as an uncertain workflow outcome, never as “not attempted.” The saved receipt remains available when its write succeeded.

This workflow permits reusing an uncertain reservation for at most **15 minutes**, a conservative local guard. It does not claim that PayPal retains keys indefinitely or that this duration is PayPal's documented policy. After that guard expires, inspect and resolve the original operation; no new key is generated automatically. PayPal's own idempotency retention and API semantics still govern external deduplication. The workflow does not provide a cross-process transaction spanning the local filesystem and PayPal.

## Module contract

```js
const workflow = createSandboxWorkflow({ store, env });
await workflow.create({ caseId, invoiceId, value, currencyCode, retryCreate: false });
await workflow.read(caseId);
await workflow.capture(caseId, { confirmCapture: true });
await workflow.reconcile(caseId);
await workflow.exportCase(caseId);
```

`clientFactory` and `clock` are test seams. A factory-injected adapter always creates **synthetic-fixture** provenance even if its return value says `paypal-sandbox`; it cannot demonstrate an authentic request. Network operations reject cases whose stored source differs from their adapter source. Offline reconciliation/export retain the stored source.

Public results contain the core's minimized evidence, relevant IDs, operation/disposition and record hashes. They do not print raw PayPal responses, payer details, approval links or credentials. Private snapshots retain original provider JSON, which may contain buyer data and must not be published wholesale. Errors expose fixed messages and, when relevant, the existing idempotency UUID, not raw upstream bodies.

If a case has only local case/request records and no saved provider response or verified event, its exported provenance is `no-provider-evidence`. `configuredSource` records the intended environment without presenting it as an executed integration.

## Webhooks and boundaries

There is no webhook file import in this CLI. The separate [webhook receiver](./WEBHOOK-RECEIVER.md) calls the real configured `verifyWebhook({headers,event})` adapter and passes its successful returned envelope directly to the store. That path has now stored the authentic event documented above. A JSON file that labels itself verified is insufficient and is deliberately not an input to this CLI.

The existing scope remains one invoice/order/purchase unit, CAPTURE intent and supported currencies. The tool does not execute refunds, model recommendations, production payments or bank reconciliation. An offline result becomes stale according to its original snapshot time; exporting does not refresh it.

## Validation

`node --test tests/sandbox-workflow.test.mjs` covers durable reservation before network, create recovery, separate capture keys, explicit capture decisions, fresh-read gating, amount mismatch, timeout followed by actual completion, unchanged-key retry, post-capture read failure, private/public data separation, offline export and sandbox-only client validation. Every provider call in these tests uses an injected client and is labeled synthetic. No real credentials or API calls are used by the tests. The coordinator's integrated suite passed **126/126** at approximately 04:50 UTC on 2 October 2026; the two authentic sandbox executions are separately documented above.
