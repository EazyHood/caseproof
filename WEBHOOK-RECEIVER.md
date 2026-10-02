# Local sandbox webhook receiver

`scripts/webhook-server.mjs` is a separate, dependency-free receiver. It does not modify the app server, serve files, create a tunnel, register a webhook, approve a payer or capture an order. Running it without arguments prints help and does not open a port. No `.env` file is read by the script.

The receiver is implemented and tested with injected clients and loopback HTTP. Separately, a controlled sandbox run received and stored a genuine PayPal event after successful postback verification. The automated tests do **not** stand in for that integration evidence.

## Recorded authentic delivery

Case `cp-live-sandbox-002` links order `95540662N9576413K` to completed capture `2UP821765V0648713` for **49.00 USD in fictitious funds**. The [minimized export](./evidence/exports/cp-live-sandbox-002-1790916633232-2b97bef0.json) includes `PAYMENT.CAPTURE.COMPLETED` event `WH-3JF99413UD730984M-3WE900643R479401V` and its stored record reference. The [replay evidence](./evidence/exports/sandbox-002-verified-replay.json) preserves SUCCESS via `paypal-postback`, with receipt/verification timestamp `2026-10-02T04:49:13.369Z`. The durable event record is timestamped `04:49:13.379Z`.

This records **one authentic delivery**. A subsequent local replay supplied that saved verified event twice and produced one excluded duplicate while keeping the completed total at 49.00 USD. No second network delivery or fresh signature verification occurred during that replay. The minimized artifacts retain original timestamps and local record hashes; they omit the private payload and do not independently attest authenticity cryptographically. See [VALIDATION.md](./VALIDATION.md) for the separate capture, model and test evidence.

## Run after configuring the sandbox endpoint

Supply `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_WEBHOOK_ID` in the process environment. The webhook ID must belong to the sandbox app and endpoint being used. Never put credentials in CLI arguments. An operator may load their private environment file separately using Node's environment-file support.

```text
node scripts/webhook-server.mjs --help
node scripts/webhook-server.mjs --run --case CASE_ID
node scripts/webhook-server.mjs --run --case CASE_ONE --case CASE_TWO --store ABSOLUTE_PRIVATE_DIRECTORY
```

The default store is `evidence/private/sandbox-cases/`. The CLI checks each selected case before listening. Cases must already exist and have `paypal-sandbox` provenance. At most 16 unique case IDs are accepted; incoming JSON cannot select a case, store directory or source.

The server binds only `127.0.0.1`, on port 5190 by default. `CASEPROOF_WEBHOOK_PORT` may select another port from 1024–65535. `CASEPROOF_WEBHOOK_PATH` may set `/webhooks/paypal/` followed by a 24–96 character URL-safe token; otherwise a fresh 192-bit random token is generated. The startup message shows the local endpoint. Keep that path private and stable when using delivery retries. Changing it requires updating the registered endpoint.

External exposure is a separate operator decision. If a trusted local HTTPS tunnel forwards the public Host header, set `CASEPROOF_WEBHOOK_HOST` to that exact lowercase DNS hostname, without a scheme, wildcard, path or port. The receiver accepts that hostname with no explicit port or with `:443`, as well as the exact local loopback port. It does not trust `Forwarded` or `X-Forwarded-*` headers. The tunnel must connect to the loopback listener. Do not point the tunnel at the app server on port 5189.

## Verification, association and acknowledgement

The only route is an exact POST target. Query strings, encoded path aliases, browser Origin/fetch headers, compressed bodies, repeated signature headers and non-JSON content are rejected. The request is limited to 64 KiB, 32 JSON nesting levels, 12 KiB of headers and four concurrent operations. Duplicate JSON object keys and invalid UTF-8 are rejected instead of silently altering their meaning.

The parsed original event and only the five PayPal signature headers go to the existing sandbox adapter's `verifyWebhook`. The adapter posts them with the server-configured webhook ID to PayPal's fixed sandbox verification API. The receiver never downloads the incoming certificate URL itself. It accepts only a successful `paypal-postback` envelope containing the same event JSON. Production persistence receives that exact envelope, preserving its event, source and verification/observation timestamps. No delivery metadata, HTTP signatures, OAuth tokens or request headers are saved.

After successful verification, the receiver reads all selected cases and associates the event through its order ID or a capture already present in saved snapshots. `CHECKOUT.ORDER.*` events use `resource.id`; other events use `supplementary_data.related_ids.order_id` when present. Without an order ID, capture identity can come from `capture_id`, a sandbox capture `up` link or `resource.id`. An explicit conflicting order ID cannot be rescued by a known capture ID. Multiple possible cases or conflicting known capture ownership fail closed. An unreadable case is an error, not evidence that the event is unrelated.

For an associated event, HTTP 200 is sent only after `saveVerifiedWebhook` resolves, including the store's durable sync. An exact duplicate is verified again and durably deduplicated. Reusing an event ID for changed JSON is an error. A successfully verified event unrelated to every selected case receives the same generic 200 acknowledgement and is not retained; selecting cases and event subscriptions correctly is therefore important. Failed verification returns 401. Dependency, association or storage failures return sanitized 503 responses with `Retry-After: 5`. No case contents or private exception messages appear in HTTP responses.

Reading a body has a 10-second limit. The complete operation has a 40-second deadline; the adapter also bounds each exchange to 15 seconds. Disconnects and deadlines cancel outbound verification and stop a late result from reaching the store. A disk append already in progress cannot safely be cancelled: it may finish after a deadline or disconnect, but no success is acknowledged then. A later delivery is deduplicated against the resulting durable record. The in-flight slot stays occupied until that append settles.

PayPal describes non-2xx delivery retries and verification by postback in its [webhooks overview](https://developer.paypal.com/api/rest/webhooks) and [integration guide](https://developer.paypal.com/api/rest/webhooks/rest/). The [simulator documentation](https://developer.paypal.com/api/rest/webhooks/simulator/) says simulator events cannot be verified through the postback endpoint; this receiver does not bypass verification for them.

## Embedded API and tests

```js
const server = createWebhookServer({
  store, caseIds: ['case-id'], env,
  routePath: '/webhooks/paypal/a-stable-private-token-of-at-least-24-chars',
  allowedHostnames: []
});
server.listen(5190, '127.0.0.1');
```

The factory never reads ambient environment variables or starts listening. Its return value is an `http.Server` with read-only `webhookPath` and `evidenceSource` properties. The optional `clientFactory` is a test seam; any injected client forces `synthetic-fixture` source and `fixture-assertion-not-cryptographic` verification method and cannot write a `paypal-sandbox` case. Tests also exercise the actual adapter with an injected transport while retaining fixture provenance.

```text
node --test tests/webhook-server.test.mjs
```

The coordinator's integrated suite passed **126/126** tests at approximately 04:50 UTC on 2 October 2026. Those test transports remain simulated even though the separate authentic delivery above is now recorded.

This small receiver is intended for a controlled sandbox demonstration. It does not provide managed hosting, automatic webhook registration, a production API, a background retry queue, credential rotation, multi-process scheduling or unattended operations. The endpoint used for the demonstration does not establish an ongoing public service. Evidence files retain the provider event JSON and may contain payer information; the private store must not be published. For unknown events, future processing requires a new PayPal delivery because the receiver intentionally keeps no copy.
