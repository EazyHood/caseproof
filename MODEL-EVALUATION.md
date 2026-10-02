# Local model evaluation

Runner: `scripts/evaluate-model.mjs`. Three completed runs contain **18 actual local-model responses** on six hand-authored synthetic cases. The runtime is Ollama **0.32.1**, with the official **`qwen3:4b-instruct-2507-q4_K_M`** model (approximately 2.5 GB; download SHA-checked). Its separate contract tests use injected transport and are not inference evidence.

To deliberately repeat the evaluation with the installed model, run:

```sh
node scripts/evaluate-model.mjs --run
```

The default requested model is `qwen3:4b-instruct-2507-q4_K_M`. To evaluate another already-installed model, pass `--model NAME`. The script never installs, pulls or starts a model. Without `--run`, it prints instructions and makes no requests.

## Recorded runs and limits

| Artifact | Implementation at execution | Structured acceptance |
|---|---|---:|
| [Baseline, 04:36:08 UTC](./evidence/model-evaluations/evaluation-20261002043608562-52e47edb.json) | Original prompt and general schema | 3/6 |
| [Current-state prompt, 04:36:49 UTC](./evidence/model-evaluations/evaluation-20261002043649627-ae0974fe.json) | Clarified that claims describe current observations, not a future action's result | 4/6 |
| [Case-specific schema, 04:37:22 UTC](./evidence/model-evaluations/evaluation-20261002043722213-ac15179f.json) | Permissible actions, current state/amount/currency and reference IDs constrained during decoding; independent validator retained | 6/6 |

All three reports are from 2 October 2026 UTC and retain their original outputs, including failures. All 18 responses report the requested model and completed generation. The final six outputs were independently revalidated with matching saved results. This is a development progression on reused fixtures, not an independent test set or a claim of general accuracy. Case-specific decoding supplies permissible values; the final 6/6 measures structural and policy conformance, not unconstrained reasoning.

Prose can still be false after structured acceptance. The baseline stale-snapshot explanation called old data current. The final run said an invoice was already marked paid despite no accounting action and described a completed amount of zero as matching an expected 49.00 USD. `explanationVerified` remains false. The UI keeps this draft text collapsed behind an explicit warning and displays calculated state/amounts separately.

The coordinator also saved [one response from local-model analysis of an authentically inspected sandbox order](./evidence/exports/sandbox-001-local-ai.json). It was recorded at `2026-10-02T04:49:38.659Z` and uses a fresh server-side GET observation at `04:49:32.368Z`. Its `record_payment` proposal passed structured checks for a completed fictitious 49.00 USD capture, with `execution:none` and `explanationVerified:false`. The explanation again says the invoice is already marked paid, although no accounting action occurred. This response is additional to the 18 batch outputs; neither artifact set claims a complete count of all development inference calls or a model-quality benchmark. The [sandbox export](./evidence/exports/cp-live-sandbox-001-1790916352260-2e56d58c.json) and [timeline](./evidence/exports/sandbox-001-timeline.json) preserve the separate payment observations. A second sandbox case now also supplies a genuine postback-verified webhook and a labeled local replay; see [VALIDATION.md](./VALIDATION.md). Webhook authenticity does not validate model prose.

## Execution and artifact contract

The runner sends the six existing synthetic cases sequentially through `createOllamaGenerator`, directly to `http://127.0.0.1:11434/api/chat`. Limits are explicit: 4096 context tokens, at most 768 generated tokens, temperature 0, 120-second request timeout and a two-minute keep-alive. The extended timeout allows for local model loading; there are no hidden retries or parallel inference calls. The shared generator now also defaults to bounded 4096/768 limits, while keeping its existing 45-second default timeout for ordinary callers.

Each case records the expected deterministic result, its prompt hash, original response hash, bounded known proposal fields, validation result, latency and the model/usage/duration metadata returned by Ollama. An unexpected reported model is visible separately from the requested name. Weight digest and runtime version are not queried, so the artifact does not claim to pin model weights. The hash of the runner, prompt/validator, reconciliation, money and fixture source files identifies the code at the start of the run.

Outputs are `accepted`, `rejected`, `incomplete` or `error`. Acceptance concerns structured state, amount, permitted action and citations; it does not verify the explanation prose or establish general model accuracy. A token-limit termination is preserved in `runtime.doneReason`. Errors retain a bounded classification, not arbitrary upstream diagnostic text. Known proposal fields are retained with size and credential-pattern checks; unknown field values and malformed raw output are omitted. `outputProjection` explains any omission. Validation always uses the original output before that projection.

The complete report is saved to a new, never-overwritten JSON file under `evidence/model-evaluations/` after the six cases finish. Maximum artifact size is 256 KB. No environment variables, authorization headers, account credentials or PayPal responses are read by the runner. Its only financial inputs are the hand-authored fixtures. The exit status is nonzero if any case rejects, fails or is incomplete, while the report still preserves those outcomes.

Contract tests inject transport and label their reports `injected-test-transport`; `actualLocalInferenceObserved` remains false for them. The direct AI/evaluation suite passed 13/13 at its recorded execution; the final integrated suite is tracked in `VALIDATION.md`. Run these offline tests with:

```sh
node --test tests/evaluate-model.test.mjs test/ai.test.js
```

Ollama documents the [`num_ctx` and `num_predict` parameters](https://docs.ollama.com/modelfile) and the [chat endpoint's structured output, usage and duration fields](https://docs.ollama.com/api/chat). Those API contracts guided the implementation; the saved completed runs provide the observed behavior and its limitations.
