---
description: "Configure bounded, keyless Unix-socket action review against the instructor-owned gateway."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-action-review-linux

English | [中文](README.zh.md)

## Summary

Submit complete tool actions to the instructor's reviewer without placing model keys in the research worker. The provider checks durable receipts against the exact request bytes and pins the gateway, destination policy, and review configuration identities. Deadlines and byte limits reject incomplete work without truncating executable input.

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

Mount this provider and the [`guard`](../action-review-guard/README.md) beside the existing tools and network-scope services inside the dedicated Linux course runtime.

```yaml
- name: '@deepseek-ai/dsh-experimental-action-review-linux'
- name: '@deepseek-ai/dsh-experimental-action-review-guard'
```

| Field | Default | Meaning |
|---|---|---|
| `socketPath` | `/run/course-public/control.sock` | Absolute instructor-owned gateway socket |
| `timeoutMs` | `30000` | Whole request/response deadline in milliseconds |
| `maxResponseBytes` | `1048576` | Complete JSON response byte limit |
| `maxActionBytes` | `1048576` | Complete serialized request byte limit |

The provider exposes no evaluator, credential, or arbitrary relay settings. Restore the trusted gateway after transport failures; investigate identity or response-integrity failures and restart the required guard's process before resuming research.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [transport](src/index.ts) calls only `GET /review/status` and `POST /review` over the configured Unix socket. The [decoder](src/protocol.ts) validates protocol fields, bounded identities, probability findings, exact-input SHA-256, policy hash, and positive safe-integer receipts. The first successful response pins the deployment across later status and review calls.

Cancellation, provider removal, and whole-exchange deadlines close owned requests; disposal waits for them to settle. Request serialization rejects unsupported values rather than silently dropping fields. The instructor-owned gateway commits the authoritative record and owns all LLM, JEV, or custom evaluator requests.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — deployment and trusted review configuration.
- [Tools subsystem](../../../docs/subsystems/tools.md) — native and nested dispatch.
- [Testing policy](../../../docs/testing.md) — composition and output evidence.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the trusted reviewer's separate evaluation requests and the action-review-guard consumer's logged denials.

#### KV Cache effect

The transport changes no agent prompt or schema. Review latency and evaluator token cost depend on the trusted deployment, not the agent's selected model.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Linux prerequisite** — Unix transport does not install isolation and requires a protected instructor-owned socket.
- **Not attestation** — deployment identity checks do not protect against a student controlling the host or a malicious same-process plugin.

<a id="dev-note"></a>
### Dev Note

None.
