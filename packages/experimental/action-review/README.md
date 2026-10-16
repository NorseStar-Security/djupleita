---
description: "Define complete tool action submissions, review readiness, and durable admission acknowledgements."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-action-review

English | [中文](README.zh.md)

## Summary

Request a decision for one complete tool action and inspect whether the instructor's review service is ready. Every acknowledgement identifies the exact submitted bytes, destination policy, and reviewer deployment. Choose a concrete provider and an enforcing consumer; this service alone never authorizes execution.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount [`action-review-linux`](../action-review-linux/README.md) and [`action-review-guard`](../action-review-guard/README.md), not this abstract service. This package has no configuration.

Providers implement `status(signal)` and `review(request, signal)` for `ctx.actionReview`. A review must commit in trusted storage before returning its receipt. Providers reject cancellation, lossy payload serialization, malformed output, and changed deployment identities. An allow needs nonempty evaluator findings; a deny may retain empty or partial findings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [service definition](src/index.ts) separates action review from dispatch, provider credentials, evaluator selection, and durable storage. The [types](src/types.ts) bind a complete action to a network policy and distinguish readiness from a committed admission decision. Null Session identity cannot authorize execution; no approval or policy-editing API exists.

The input hash covers the exact raw UTF-8 POST body, including the action and policy hash. It does not cover a second JSON serialization. Branded hashes and receipts retain their ordinary JSON representation; a receipt is evidence of storage, not a reusable execution permit.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — deployment and trusted review configuration.
- [Tools subsystem](../../../docs/subsystems/tools.md) — native and nested dispatch.
- [Testing policy](../../../docs/testing.md) — composition and output evidence.

<a id="model-experience"></a>
## Model Experience

Indirectly, through external evaluators that assess submitted actions and the guard consumer that renders tool denials.

#### KV Cache effect

The service adds no agent prompt or tool schema. The trusted reviewer owns its separate evaluation requests; dispatch consumers own logged denial results.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment trust required** — the service does not establish network isolation or protect an endpoint writable by the research process.
- **Probabilistic findings** — negative risk findings do not establish that an action is harmless; destination and hard operation enforcement remain independent.

<a id="dev-note"></a>
### Dev Note

None.
