# Validation record

Record date: 2 October 2026 UTC / 1 October Colombia. Environment: Windows, Node 24.16.0.

The coordinator's integrated `node --test` run passed **126/126** tests on 2 October 2026 at approximately **04:50 UTC**. Earlier recorded runs included **97/97** after the inspection-ID backend changes, **20/20** targeted HTTP tests, **13/13** direct AI/evaluation tests and **21/21** evidence-store tests. The static-build plus HTTP suite passed **27/27**; an independent review found and helped close a timing race in the DOM test by awaiting startup directly. `node --check` passed for the server, frontend and static builder. These counts describe recorded executions, not inferred coverage or real-service calls.

Automated provider/model transport tests use in-memory stubs; their financial examples are hand-authored synthetic fixtures. Separate saved evaluations below contain actual local model calls using those same fixtures. Two authentic sandbox cases, a verified webhook and a saved inspection/model response are documented separately. None of these results establishes real-money settlement, merchant outcomes or a deployed application.

## Tested behavior

- Exact decimal arithmetic; unsupported precision/currencies rejected.
- Duplicated event/capture IDs counted once; conflicting duplicate contents block decisions.
- Pending captures, amount discrepancies, stale snapshots, invoice/order/currency mismatches and unknown statuses cannot be marked paid.
- Order completion alone is insufficient without capture records.
- Invalid signatures cannot create payment evidence or suppress a later verified event.
- Late/historic events do not regress an already completed capture; newer verified events require a new snapshot.
- Refunds present in the snapshot, and verified refund events linked by capture ID or PayPal `up` link, route to review without asserting a net balance.
- Fixed sandbox origin, rejected path injection/redirects, token caching, explicit request IDs and absence of hidden capture retries.
- Timeout/failed mutation remains an unknown outcome. Error reporting excludes arbitrary API bodies and request secrets.
- Webhook verification uses the configured subscription ID, accepts only exact SUCCESS, and binds an immutable copy of the submitted event.
- AI structured assertions cannot choose a disallowed action, invent amounts or evidence IDs, omit payment support, or change the expected schema. Malformed output is rejected. Free-form prose is explicitly not semantically verified.
- Optional local model adapter sends a JSON schema to a loopback endpoint; failures are surfaced without a fabricated answer.
- Case-specific decoding limits state, amount, currency, action and reference IDs to the current reconciliation; the independent validator still rejects a response that ignores those limits.
- Persistent JSONL evidence preserves original source, timestamps and stable operation UUIDs across restart. Duplicate acknowledgements require file sync, including after an earlier sync failure. Equivalent observation timestamps cannot hide conflicting snapshots, and equivalent decimal amounts retain original JSON without a false identity conflict.
- The sandbox workflow CLI is implemented and independently reviewed. Its tests use injected clients; authentic integration evidence is recorded separately below.
- Inspection IDs are opaque, expire after five minutes and are scoped to one server process. Analysis re-fetches the bound order and returns the fresh reconciliation used by the model. Tests reject client evidence, mixed selectors, unavailable/expired IDs, wrong provider identity and failed-refresh fallbacks; the cache is bounded to 128 contexts and excludes provider JSON/payer data.

`node src/demo.js` also completed successfully, showing six labeled fixture cases. It performs no network access and writes no payment state.

## Independent review

A separate review agent inspected the core and reproduced three issues in the first 30-test version: omitted refund relationships, ignored snapshot refund collections, and a mutable event reference after signature verification. The implementation now handles those relationships/collections and freezes the exact verified JSON; regression tests cover all three. An additional malformed-AI-output case and numeric event-amount normalization were also added.

The reviewer independently repeated all three original reproductions after the fixes and confirmed they were closed. Their verification also passed all 35 tests and confirmed malformed AI evidence arrays are rejected without throwing.

An independent persistence review reproduced two further defects: a duplicate could acknowledge a record after a failed file sync without syncing again, and equivalent timestamp formats could admit contradictory snapshots. Both were fixed and independently rechecked. The store suite also covers malformed arrays/envelopes, immutable identities, source separation, replay, corrupt/truncated files, locks, path validation, hard links and bounded records. See [EVIDENCE-STORE.md](./EVIDENCE-STORE.md) for the precise guarantees and exclusions.

## Authentic PayPal sandbox run

The coordinator completed order creation, sandbox-buyer approval, capture and follow-up reads. The [minimized export for `cp-live-sandbox-001`](./evidence/exports/cp-live-sandbox-001-1790916352260-2e56d58c.json), written at **2026-10-02T04:45:52.258Z**, records:

| Field | Saved evidence |
|---|---|
| Order | `63W11482XV2348118`, status `COMPLETED` |
| Invoice | `CP-SBX-20261002-001` |
| Capture | `4D1364913R338640H`, status `COMPLETED` |
| Amount | `49.00 USD` / `4900` minor units, fictitious sandbox funds |
| Follow-up snapshot fetched | `2026-10-02T04:45:20.692Z` |
| Reconciliation at export | `paid`, difference `0.00`, proposed action `record_payment` |
| Stored receipt | Nine record hashes, with separate create/capture request reservations |
| Webhook evidence | No webhook record in this first case's export; the second case below supplies the verified-event evidence |

The export omits raw provider JSON, payer details, approval links and authentication material. Its hash references are an audit aid, not independent cryptographic proof from PayPal. `paid` describes the inspected completed-capture amount; it does not mean an accounting action or bank settlement occurred. Exporting does not refresh the original snapshot, so the saved conclusion is tied to its recorded observation time.

The [minimized timeline](./evidence/exports/sandbox-001-timeline.json) records this order as CREATED at `2026-10-02T04:40:14.701Z`, APPROVED at `04:42:09.698Z`, and COMPLETED with its capture at `04:45:19.587Z`, followed by the read above. These are saved provider observations, not a claim that replaying the file repeats checkout.

The coordinator also completed authentic sandbox inspection and local-model analysis through the `resultId` path. The [saved response](./evidence/exports/sandbox-001-local-ai.json), recorded at `2026-10-02T04:49:38.659Z`, contains a fresh server-side GET observation at `04:49:32.368Z`, the same reconciliation returned to the UI and a structurally accepted `record_payment` proposal. `execution` is `none` and `explanationVerified` is `false`. Its prose says the invoice is already marked paid; no accounting action supports that statement. This is separate from the synthetic batch evaluations below and is not a prose-accuracy result.

## Second sandbox case: verified event and local replay

The [minimized export for `cp-live-sandbox-002`](./evidence/exports/cp-live-sandbox-002-1790916633232-2b97bef0.json), written at **2026-10-02T04:50:33.230Z**, preserves:

| Field | Saved evidence |
|---|---|
| Order / invoice | `95540662N9576413K` / `CP-SBX-20261002-002` |
| Capture | `2UP821765V0648713`, COMPLETED, `49.00 USD` in fictitious funds |
| Event | `WH-3JF99413UD730984M-3WE900643R479401V`, `PAYMENT.CAPTURE.COMPLETED` |
| Event creation time | `2026-10-02T04:48:59.575Z` |
| Recorded receipt / verification time | `2026-10-02T04:49:13.369Z`; SUCCESS using `paypal-postback` |
| Durable event record time | `2026-10-02T04:49:13.379Z` |
| Latest order read | `2026-10-02T04:50:33.131Z` |
| Reconciliation / receipt | `paid`, `4900` completed minor units, zero difference; 11 stored records |

The verification metadata and original record hash are retained in the [verified-event replay artifact](./evidence/exports/sandbox-002-verified-replay.json), recorded at `2026-10-02T04:50:37.554Z`. One saved event gives `duplicateEvents:0`; two local copies give `duplicateEvents:1`. Both reconcile to `paid` and `49.00` completed. This demonstrates deduplication of the same authentic, previously verified event in a local replay. **It does not demonstrate two PayPal network deliveries, a new verification during replay, or a second capture.** Hash references help trace the local records; the minimized files are not independent PayPal attestations.

## Actual local model evaluations

Ollama **0.32.1** is installed. The official **`qwen3:4b-instruct-2507-q4_K_M`** model download (approximately 2.5 GB) was SHA-checked by the coordinator. The following reports contain **18 completed local model responses**, all on the six hand-authored development fixtures. Their reported model matches the request; all responses completed with `done:true` and `doneReason:stop`. This count covers only these three saved batch evaluations.

| Saved run | Change | Structured acceptance | Rejected |
|---|---|---:|---:|
| [04:36:08 UTC](./evidence/model-evaluations/evaluation-20261002043608562-52e47edb.json) | Baseline | 3/6 | 3 |
| [04:36:49 UTC](./evidence/model-evaluations/evaluation-20261002043649627-ae0974fe.json) | Prompt distinguishes current observations from a proposed future action | 4/6 | 2 |
| [04:37:22 UTC](./evidence/model-evaluations/evaluation-20261002043722213-ac15179f.json) | Case-specific decoding constraints; independent validator retained | 6/6 | 0 |

The earlier failures remain preserved. They include claiming captured funds before capture, a disallowed capture action for an underpaid order, and invalid reason codes. An independent review revalidated the final six outputs against the current validator and obtained the saved results; the final report's `ai.js` source hash also matched. The reports retain prompt/source/response hashes, bounded outputs, runtime metadata and explicit synthetic-input provenance.

**Structural acceptance is not prose truth or general accuracy.** The baseline accepted a stale-snapshot explanation that called its data current. The final run still says an invoice is “already marked as paid” despite no accounting action, and one explanation describes completed amount zero as matching an expected 49.00 USD. These are real observed limitations, not hypothetical caveats. The six scenarios were reused during development; this is not an independent held-out benchmark. The final schema supplies the permissible values, so 6/6 must not be presented as unconstrained model reasoning accuracy.

## Still unverified

Public deployment, final project submission and judging access remain unverified. Authentic sandbox create/approve/capture/read, inspected-order AI, one genuine verified webhook, its explicitly local replay and the integrated test run are recorded above. A second network delivery, production operation and real-money proceeds are not claimed.

PayPal and Qloo event registrations are confirmed. The Caseproof Devpost draft (`1209870-caseproof`) is saved at **2/5**; no project submission has been sent. Qloo's API-key request is confirmed and delivery is pending by email, with several business days expected. These administrative milestones are separate from technical integration evidence. The [MIT License](./LICENSE) is now included, copyright 2026 Jhonatan del Rio Mejia. Repository publication and a public or unlisted YouTube video under three minutes remain pending.

## Local HTTP and UI verification

- HTTP tests cover exact Host/Origin validation, CSRF boundary, size/content-type/body validation, fixed static routes, sanitized failures, explicit missing configuration, server recomputation of fixture evidence, test-adapter provenance and request cancellation. The independent reviewer also exercised a timed-out adapter operation and an interrupted body.
- All six cases were opened in the Codex in-app browser. Duplicate delivery remains 49.00 USD, approval proposes review before capture, pending capture proposes waiting, and amount/staleness inconsistencies propose refreshing/manual review. The unverified event is visibly excluded and does not establish payment.
- Browser rendering checked at requested widths 375, 768 and 1280px (content widths exclude scrollbar). No page-wide horizontal overflow at mobile/tablet. Desktop also passed. Mobile scenario navigation intentionally scrolls horizontally within its own container.
- Keyboard smoke check: Tab from the approved-order button focuses the pending-capture button; Enter loads the pending case. This is not a screen-reader audit.
- A dedicated **injected test server** (`scripts/ui-smoke-server.mjs`, port 5190) exercised rejected model output with a string instead of an evidence array and an HTML-like explanation. The UI displays the rejection and all errors, renders the explanation as text, and explicitly labels the output as injected. No actual AI model was called.
- The same test server fails its first order read. “Try again” was confirmed to retry that read and display the second, injected response with the warning that it is not authentic PayPal evidence. It does not redirect to a paid example.
- Review findings fixed: unsafe assumption about model citation array type; contradictory inspection provenance copy; incorrect retry target; missing live status region for AI errors. Responsive review also fixed a missing space when a desktop line break disappears.
- The earlier browser smoke run showed absent sandbox/AI configuration explicitly and produced no fabricated substitute; its browser error/warning log was empty. Local model setup and the saved evaluations occurred afterward, so that earlier configuration screen is not the current inference status.
- The current UI keeps model prose collapsed under **“Read the unverified model explanation”**. Its concrete warning says the draft may contradict evidence or describe actions that have not happened and directs the reader to the calculated amounts and state. “Structured checks passed” remains separate from that unverified prose; no action executes.
- The inspected-order path updates the displayed ledger from the returned analysis result while preserving generation/selection checks. Expired IDs offer a new inspection; a late response from an earlier case cannot replace the selected case. Independent review passed the 20 HTTP tests and four targeted DOM checks covering late inspection/analysis responses, retry of the original expired inspection, and literal/collapsed prose.
- The static build emits exactly 12 allowlisted files. Tests seed forbidden `.env`, private evidence, artifacts and unrelated public files and confirm none enter the output. A DOM execution checks all six scenarios under a project subpath, with no `/api/` requests and both service controls disabled. Independent review confirmed the historical sandbox projection excludes payer/request IDs and authentication fields. No separate visual browser audit of this static build is claimed here.

PNG evidence is in `../../outputs/busqueda-nuevas-2026-10-01/`: `caseproof-desktop.png`, `caseproof-tablet-768.png`, `caseproof-mobile-375.png`, `caseproof-preview.png`. These are fresh native browser captures of synthetic fixture mode, not evidence of a live payment. The mobile/desktop evidence was recaptured on the normal app after closing the injected QA server tab.

No physical mobile device test, full assistive-technology audit, merchant trial or independent semantic-accuracy study has been performed. The app currently uses an intentional light theme. UI, server and core remain a local prototype, not a submitted entry.
