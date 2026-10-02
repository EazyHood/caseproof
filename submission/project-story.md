## Inspiration

An order can be approved without being captured, and a webhook can be delivered more than once. Those possibilities leave a merchant with a practical question: **was this invoice captured once, and what should I do next?**

Caseproof is a small evidence desk for that moment. It gives an operator one inspectable reconciliation before an AI explanation or a payment decision.

## What it does

Enter an expected invoice, amount and PayPal sandbox order. Caseproof reads the order, totals completed captures using exact minor-unit arithmetic, and shows the difference with a source for each conclusion. Approval alone never counts as payment. Duplicate events do not inflate the amount. Unverified events are excluded; conflicting, stale or unsupported evidence holds the decision for review.

A local language model proposes a next step and explanation. An independent validator checks the action, amount, state and cited evidence against the reconciliation. The prose remains explicitly unverified even when those structured checks pass. The model cannot execute payments.

The separate operator CLI creates and captures sandbox orders with durable request IDs. Before considering a capture, it reads and reconciles the order again. Its append-only local evidence store preserves the original responses privately and exports a minimized record for review.

## What we actually demonstrated

- Two authentic PayPal sandbox journeys: create, buyer approval, capture and read-back, each for **49.00 USD in fictitious funds**.
- An authentic `PAYMENT.CAPTURE.COMPLETED` notification on the second journey, with successful PayPal signature verification before storage.
- Two **local replay copies of that saved verified event**: the total remains 49.00 USD and one duplicate is excluded. This is a local replay, not a claim of two network deliveries.
- Actual local-model inference on an inspected sandbox order, plus three development runs on six synthetic edge cases.
- **126 automated tests passing**, covering reconciliation, HTTP boundaries, uncertain capture outcomes, storage, webhook verification and static-demo packaging.

The public demo offers six clearly labelled synthetic scenarios and a recorded sandbox receipt. It makes no live PayPal or AI calls. Clone the MIT repository to run the full local workbench; the video and minimized evidence files document the authentic integration.

## How it was built

JavaScript, Node.js, HTML and CSS; PayPal Orders v2 and Webhooks APIs; Ollama with Qwen3 4B. The core and web server have zero npm dependencies. Built individually with AI-assisted coding, followed by independent reviews, automated tests and real sandbox validation.

## Challenges and lessons

An approved order is not a completed capture. A timeout is not proof that a mutation failed. And schema-valid AI output is not necessarily a truthful explanation: the recorded evaluations include fluent but incorrect prose. Those findings shaped the separate evidence calculation, explicit operator controls and visible model limitations.

## Next

The next step is usability testing with real operators, then broader currency and refund handling. There are no claimed customers, production payments or bank-settlement guarantees in this prototype.
