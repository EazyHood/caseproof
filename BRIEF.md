# Caseproof — payment exceptions, with receipts

**Submitted:** [Devpost](https://devpost.com/software/caseproof-5gmdck) · [Unlisted video](https://youtu.be/nZk1ntRACYs) · [Offline demo](https://eazyhood.github.io/caseproof/) · [MIT repository](https://github.com/EazyHood/caseproof) · [Receipt](./submission/RECEIPT.md)

Status: submitted prototype with two authentic PayPal sandbox captures, a saved create → buyer approval → capture → read timeline, persistent evidence storage and local AI analysis of a freshly inspected sandbox order. Each capture is 49.00 USD in fictitious funds. A genuine webhook was received and verified via PayPal postback; a labeled local replay of two copies preserves one captured total. Three local model evaluations on synthetic cases are also preserved. The coordinator's full suite passed 126/126 at approximately 04:50 UTC on 2 October 2026; code reference `420a58e` is unchanged by later documentation edits. The repository and offline demo are public; the service-enabled workbench runs locally. Devpost confirmed submission **1209870** to the PayPal AI Hackathon. The 133.121-second video is unlisted, YouTube checks found no issues, and playback was verified in a separate browser.

## User and moment of use

A small merchant sees an invoice whose checkout state and payment notification appear inconsistent. Before asking the buyer to pay again or marking the invoice paid, the merchant needs to know what PayPal actually captured, which record supports that answer, and what to do next.

Caseproof compares the merchant invoice with a fresh PayPal Orders v2 snapshot, identifies unique captures, reviews signature-verified webhook events, and makes a bounded action proposal. An optional AI explains the case using the same evidence. Deterministic code checks its structured state, amount, action and citation IDs. Natural-language prose remains an explicitly unverified AI draft.

## Useful difference to demonstrate

The intended difference from a generic payment dashboard or chat answer is an evidence packet that survives duplicate notifications and misleading AI output. The recorded replay shows one capture, two local copies of an authentic verified notification, and one captured amount. It does not claim PayPal delivered the event twice. A separate saved model evaluation shows an unsupported action rejected by the guard. This is a proposed product distinction, not a researched novelty claim or an established merchant need. No user testing or time-saved measurements exist yet.

## Build scope

- Implemented: sandbox-only OAuth/Orders/capture reads and writes adapter, postback webhook verifier, pure reconciliation, decimal arithmetic, evidence references, case-specific constrained AI generation with an independent validator, explicit fixtures and automated tests. A local HTTP server and responsive evidence workbench expose six fixtures, structured proposal checks and read-only order inspection.
- Implemented and reviewed: append-only local evidence store, stable operation-specific request UUIDs, immutable case/event identity, original observation times and provenance-preserving replay. File-sync failures, conflicting snapshots and unsafe paths fail closed within the documented private-directory model.
- Implemented and independently reviewed: sandbox workflow CLI for explicit create/read/capture, offline reconciliation and minimized export. Capture requires an explicit operator flag and a fresh allowed-action check. [The authentic run export](./evidence/exports/cp-live-sandbox-001-1790916352260-2e56d58c.json) shows order `63W11482XV2348118` and completed capture `4D1364913R338640H` for 49.00 USD in fictitious funds.
- Authentic webhook evidence: [the second case export](./evidence/exports/cp-live-sandbox-002-1790916633232-2b97bef0.json) shows order `95540662N9576413K`, completed capture `2UP821765V0648713` for 49.00 USD and event `WH-3JF99413UD730984M-3WE900643R479401V`. The [replay record](./evidence/exports/sandbox-002-verified-replay.json) preserves SUCCESS via PayPal postback at `2026-10-02T04:49:13.369Z` and demonstrates deduplication using two saved copies, with no new delivery or verification.
- Inspected-order AI: opaque five-minute inspection IDs bind the expected invoice in server memory. Analysis fetches the order again, recomputes reconciliation and returns the same current result shown in the UI. Client-supplied results are not accepted; test adapters retain synthetic provenance.
- Actual model evidence: Ollama 0.32.1 with official `qwen3:4b-instruct-2507-q4_K_M` (approximately 2.5 GB, download SHA-checked). Eighteen completed responses across three six-fixture evaluations yielded 3/6, 4/6 and 6/6 structural acceptance. This is not a prose-accuracy result. Reports and concrete errors are linked in [VALIDATION.md](./VALIDATION.md).
- Integration boundary: `src/index.js`; frontend may import the pure engine and fixture module. Keep `paypal.js` and any credential-dependent use on the server.
- Static preview: the [published allowlisted 12-file build](https://eazyhood.github.io/caseproof/) provides six explicitly synthetic scenarios and a separate historical sandbox record. Inspection and model controls are disabled with local-run instructions. The build and its paths/provenance were independently reviewed.
- Temporary receiver cleanup: the single demonstration webhook subscription was [deleted with HTTP 204](./evidence/exports/temporary-webhook-cleanup.json) after verified evidence was saved. The coordinator also stopped its public tunnel; this prototype does not offer a persistent hosted receiver.
- Future product work: a built-in checkout UI, login, service-enabled public hosting, refund ledger, multi-currency settlement and broader semantic/user evaluation. The completed buyer approval used PayPal's sandbox interface. Submission packaging is complete; no judging outcome is claimed.
- Narrow financial model: one order, one purchase unit, one invoice, CAPTURE intent; USD/EUR/GBP only. Completed-capture amount is not net settlement, profit or money received in a bank account.
- No automatic payment action or automatic refund exists. `capture_order` is a proposal requiring application-level validation, a fresh read and an explicit operator action. The low-level adapter is separate and must not be exposed as an unrestricted browser endpoint.

## Event fit and evidence plan

The [official rules](https://paypalaihackathon.devpost.com/rules), checked on 2 October 2026 UTC, require central PayPal sandbox integration plus AI, a working runnable demo, public GitHub with an open-source license, English materials and a public or unlisted YouTube demonstration under three minutes. They define five equally weighted judging criteria. Devpost has confirmed the project submission; that confirmation does not establish a judging outcome.

| Criterion | Weight | Caseproof evidence to provide | Current state |
|---|---:|---|---|
| Technological implementation | 20% | Actual sandbox create → approve → capture → fetch; verified event; live model output with rejected invalid proposal | Authentic sandbox captures/read, inspected-order AI and genuine verified webhook recorded; labeled local replay and model rejection evidence saved; 126/126 integrated tests passed |
| Design | 20% | One understandable exception queue and evidence-to-action path | Local workbench implemented; desktop/mobile/tablet and keyboard smoke checks passed; no user usability study |
| Potential impact | 20% | Merchant problem, reproducible duplicate handling, honest boundaries | Synthetic case and local replay of an authentic event work; user validation pending |
| Innovation/idea | 20% | Explain why evidence-constrained payment resolution improves the decision | Proposed distinction; comparative review pending |
| Presentation | 20% | Crisp English demo of working integration, accessible repository and exact version | MIT repository and offline demo public; unlisted 2:13 video verified; Devpost submission confirmed and receipt saved |

Eligibility/entry audit: existing research indicates adult Colombian individual entry is compatible. Event registration and project submission are complete. Deadline: 12 November 2026, 17:00 Colombia. The MIT repository and offline demo are public. The [video](https://youtu.be/nZk1ntRACYs) is published as unlisted; separate browser playback reached 10.67 seconds of its 133.121-second duration. Fictitious sandbox captures are demonstrated, with no real-money proceeds or prize outcome claimed.

Related application tracking: Qloo event registration and its API-key request are also confirmed. The latest mailbox search found the Google Forms receipt and starter kit, but no API key. Key delivery remains pending; that separate application's progress does not establish any Caseproof integration.

## Future work and preserved evidence

1. Retain the minimized authentic timeline, inspection/model output, verified webhook and labeled local replay alongside the original failed model runs. Keep private provider JSON and credentials out of publication.
2. Broaden semantic evaluation beyond the six development fixtures. Retain the independent validator and the visible warning that model prose may contradict evidence.
3. Preserve the submitted [story](./submission/project-story.md), [confirmation](./submission/devpost-submitted-ax.txt) and [receipt](./submission/RECEIPT.md). Any later update should retain the distinction between a local replay and a second network delivery.

## Primary technical sources

- [Orders v2 create](https://developer.paypal.com/api/orders/v2/orders-create), [get](https://developer.paypal.com/api/orders/v2/orders-get), [capture](https://developer.paypal.com/api/orders/v2/orders-capture): API shapes and explicit capture flow.
- [Capture details](https://developer.paypal.com/api/payments/v2/captures-get): read an individual capture.
- [Authentication](https://developer.paypal.com/api/rest/authentication/): client credentials exchange to a server-side access token.
- [Idempotency](https://developer.paypal.com/api/rest/reference/idempotency/): operation-specific request IDs; retry semantics last only while PayPal retains a key. This spike does not assume permanent deduplication.
- [Sandbox](https://developer.paypal.com/sandbox-testing/overview): testing environment with fictitious accounts.
- [Webhook overview](https://developer.paypal.com/api/rest/webhooks/), [integration](https://developer.paypal.com/api/rest/webhooks/rest/), [signature verification](https://developer.paypal.com/api/webhooks/v1/verify-webhook-signature-post): receiving, retrying and authenticating events. The chosen postback method excludes simulator events.
- [Ollama chat](https://docs.ollama.com/api/chat), [structured output](https://docs.ollama.com/capabilities/structured-outputs): local schema-based generation, now exercised in the saved evaluations.

The implementation is new in this task and uses Node built-ins. Coding assistance: Codex. No third-party assets or model weights are included. Original project code uses the [MIT License](./LICENSE), copyright 2026 Jhonatan del Rio Mejia; `package.json` declares MIT.
