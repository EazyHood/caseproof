# Local evidence store

Implemented in `src/evidence-store.js`, with no external packages. This module has no network access and no payment execution. The sandbox workflow CLI and separate webhook receiver use it; the read-only workbench server keeps its short-lived inspection contexts in memory instead.

```js
import { createEvidenceStore } from './src/evidence-store.js';

const store = await createEvidenceStore({
  directory: '/an/absolute/private/server-controlled/directory'
});

await store.createCase({
  caseId: 'invoice-1042',
  source: 'paypal-sandbox',
  expected: { invoiceId: 'CP-1042', value: '49.00', currencyCode: 'USD' }
});

const reservation = await store.reserveRequest('invoice-1042', {
  operation: 'create_order',
  payload: { invoiceId: 'CP-1042', value: '49.00', currencyCode: 'USD' }
});
// reservation.requestId is persisted before this promise resolves.
// Pass that exact key to the PayPal adapter, after application authorization.
```

`directory`, `caseId`, provenance and the injected test `clock` are server-owned inputs. Never let a browser choose a path, assert successful verification or change a case's source. Suggested project-local storage is `evidence/private/`, which is already ignored by Git. The module accepts an absolute directory on either Windows or Unix.

## API and returned state

- `createCase({caseId, expected, source})`: creates an immutable case identity. `expected.orderId` may initially be absent; the first valid saved snapshot binds it. Repeating an identical creation returns the existing case; changing its invoice/source fails.
- `readCase(caseId)`: reads the complete validated case under the same lock used by writers. Returns `expected`, `source`, `requests`, `snapshots`, `latestSnapshot`, `events`, immutable `records` and timestamps. `latestSnapshot` means highest original `fetchedAt`, even if an older snapshot arrived later. Returned data is deeply frozen.
- `reserveRequest(caseId,{operation,payload})`: supports one `create_order` and one `capture_order` per case. Creation payload is exactly `{invoiceId,value,currencyCode}`; capture payload is exactly `{orderId}` and requires a bound order. Returns a generated UUID, payload hash and record hash. Repeating the same operation/payload returns the persisted key with `duplicate:true`. Changing payload is rejected. Reservations do not say that PayPal executed a request. After an uncertain request result, fetch and reconcile the order before deciding whether to retry; never create another key merely because the first request timed out.
- `saveSnapshot(caseId,envelope)`: accepts the adapter's `{data,source,fetchedAt,status,debugId?}`. Requires matching provenance, successful HTTP status and the case invoice. The original `fetchedAt` is retained; the store adds its own `recordedAt`. Saving old evidence never makes it fresh. Equivalent timestamp formats identify the same observation instant: an otherwise identical duplicate returns the original timestamp and record, while another payload at that instant is rejected. Another order or a reused capture ID with changed amount/invoice is rejected. Capture amounts in supported currencies are compared in exact minor units (`49` and `49.00` are equivalent); original JSON is retained unchanged. Unknown or malformed amounts are compared exactly without guessing. Status changes in later snapshots are retained as separate records; prior snapshots remain intact.
- `saveVerifiedWebhook(caseId,envelope)`: accepts exactly `{event,source,receivedAt,verification}`. Sandbox envelopes require `verification:{status:'SUCCESS',method:'paypal-postback',checkedAt}` from the real adapter. Fixtures require the explicit `fixture-assertion-not-cryptographic` method. It links events to the bound order or a saved capture, including refund `capture_id`/sandbox `up` links. A duplicate event ID with the same event JSON returns its original stored record and `duplicate:true`; different contents are rejected. Duplicate attempts do not rewrite timestamps or add a new delivery claim.
- `replayEvents(caseId,{copies:2})`: returns the saved event envelopes duplicated in memory, with original source/verification/timestamps and a `replay` annotation containing the original record hash. The top-level provenance says `stored-replay`. It writes no new records, performs no new verification and does not fabricate a PayPal delivery. One through ten copies are supported.

For reconciliation, use `readCase().expected`, `.latestSnapshot` as `order`, `.events` and the current server observation time. For a replay demonstration, use `.events` from `replayEvents`; display its top-level provenance notice. A synthetic case remains synthetic forever.

## Storage guarantees and limits

Each case uses one append-only UTF-8 JSONL file. Each record contains a sequence number, the previous record hash and a SHA-256 hash of its canonical content. A file sync completes before a successful write returns. An append can finish before its sync fails; the resulting complete record may be visible despite the failed operation. Identical retries sync the existing file again before acknowledging success, including case creation, request reservation, snapshots and webhooks. They do not generate another key or append another record. Reads reject a broken hash chain, invalid sequence, invalid UTF-8 or incomplete final line. They do not silently drop a partial record or truncate a file. The hash chain detects corruption; it is **not a signature or protection against an attacker who can rewrite the directory and recompute hashes**. Removing entire valid records from the end also cannot be detected without an external checkpoint.

Same-process operations are serialized per case, including operations from separate store instances. An exclusive filesystem lock prevents a second process from entering concurrently; it gets `STORE_BUSY` rather than waiting or writing. A process crash can leave its lock behind. Inspect the process/file state before removing such a lock manually; the store never guesses that a lock is stale. A crash during append can leave an incomplete record, which must be recovered explicitly from retained evidence. This is not a transactional database or a cross-machine lock. File sync does not establish a tested guarantee against every filesystem/device/power-loss failure.

Case IDs are lowercase, bounded and exclude separators, dots, colons and Windows device names. Evidence files must be regular single-link files; symlinks and hard links are refused. The directory must be private and trusted. This is not designed to defend against a local attacker swapping filesystem objects between checks. File permissions request 0700/0600; Windows ACL behavior is not an encryption guarantee.

Known secret/header field names and recognizable bearer-token/credential-URL patterns are rejected, including when nested. They are not redacted because that would change the verified event. This is an explicit accidental-secret guard, **not universal secret detection**: arbitrary text can contain information the program cannot recognize. No raw HTTP headers are stored. Provider JSON may include buyer data; keep the directory private and publish only deliberately minimized evidence. The store preserves parsed JSON content, not original HTTP body byte layout or a certificate chain. Non-JSON array holes, extra properties and accessors are rejected without invoking custom array methods or getters. It relies on the server's prior verification and does not cryptographically reverify an event when reading it back.

Limits are 128 KB per record and 1 MB per case. Exceeding a limit fails before append; no automatic eviction, archival or silent truncation occurs. The current scope is one invoice, one order and one operation of each supported type per case. Request UUIDs are generated locally; this does not extend PayPal's own idempotency-retention period.

## Webhook integration boundary

The separate [webhook receiver](./WEBHOOK-RECEIVER.md) keeps ingestion outside the browser POST routes: PayPal does not send the browser's Origin header, so that same-origin rule cannot be reused unchanged. It uses a dedicated path with a strict body cap, preserves the received event, calls the configured server-side PayPal verifier, and passes only a successful returned envelope to the store. It resolves the case from server-owned order/capture mappings, never from an asserted client case path.

An associated accepted delivery is acknowledged only after its evidence record is durably saved. An identical duplicate is verified again and can be acknowledged from its existing durable record. Verification failure creates no evidence; temporary verifier or storage errors remain distinguishable so retry behavior is deliberate. The receiver does not expose the filesystem store, arbitrary replay writes or payment execution.

## Recorded integration evidence

Two actual sandbox workflows used this store. The first case's [timeline](./evidence/exports/sandbox-001-timeline.json) preserves CREATED, APPROVED and COMPLETED provider observations. The [second case export](./evidence/exports/cp-live-sandbox-002-1790916633232-2b97bef0.json) contains 11 record references, including `webhook_saved` at sequence 10 for event `WH-3JF99413UD730984M-3WE900643R479401V`. Its recorded verification was SUCCESS via `paypal-postback` at `2026-10-02T04:49:13.369Z`; the event record was saved at `04:49:13.379Z`.

The [local replay artifact](./evidence/exports/sandbox-002-verified-replay.json) retains that event's source, verification time and original record hash. Supplying one copy yields zero duplicates; supplying two saved copies yields one duplicate. Both reconcile to 49.00 USD captured. This is one actual received event followed by local replay, not two network deliveries or new signature verification. The files are minimized review artifacts, not cryptographic attestations from PayPal. The original provider payloads remain private.

## Validation

`node --test tests/evidence-store.test.mjs`: **21 passed** at the recorded targeted run; the coordinator's subsequent full suite passed **126/126** at approximately 04:50 UTC on 2 October 2026. Tests use private temporary directories inside this project and clean them up. They cover restart/readback, exact-key reuse, concurrent instances, injected sync failure and durable retry for all four write operations, immutable case/capture/event identity, equivalent decimal amounts and observation timestamps, stale timestamps, source separation, refund linkage, replay attribution, secret rejection, malformed JSON/envelopes, truncated/corrupted files, external locks, hard links and size limits. These automated tests use no credentials or real API calls; authentic sandbox observations are the separate records above.
