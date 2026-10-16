---
description: "Configure and debug the read-only Linux gateway provider for instructor-enforced domain/IP scope."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-network-scope-linux

English | [中文](README.zh.md)

## Summary

Read live policy, readiness, target decisions, and network denials from the course gateway. Requests use a local Unix socket and never use the research HTTP proxy. The provider pins the first gateway identity and policy hash, then rejects unexpected changes. It cannot install, widen, or disable network rules.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider only inside the instructor-controlled [course runtime](../../../course/scope-runtime/README.md), then mount the guard consumer. The package does not create Linux isolation by itself.

```yaml
- name: '@deepseek-ai/dsh-experimental-network-scope-linux'
- name: '@deepseek-ai/dsh-experimental-network-scope-guard'
```

| Field | Default | Meaning |
|---|---|---|
| `socketPath` | `/run/course-public/control.sock` | Absolute path to the instructor-owned read-only inspection socket |
| `timeoutMs` | `3000` | Whole inspection deadline in milliseconds |
| `maxResponseBytes` | `2097152` | Maximum response body bytes |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-network-scope-linux) owns accepted configuration. Transport and health failures block dispatch through the consumer; restore the gateway before retrying. Identity changes, malformed output, and audit gaps require instructor investigation and consumer reload.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [provider](src/index.ts) sends bounded `/inspect` requests to the root-owned gateway socket. The course mounts its containing volume read-only, so the research process cannot replace that endpoint. The [decoder](src/protocol.ts) validates protocol identity and contiguous audit sequences before exposing immutable snapshots. Disposal cancels and drains owned HTTP requests. This handshake observes a trusted deployment; it is not cryptographic attestation or proof of confinement on an arbitrary host.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — deployment, policy, and enforcement boundary.
- [Tools subsystem](../../../docs/subsystems/tools.md) — execution pipeline for native and PTC calls.
- [Testing policy](../../../docs/testing.md) — composition and recorded-Session evidence.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the network-scope-guard consumer that renders policy status and dispatch denials.

#### KV Cache effect

The transport contributes no model tokens or prompt changes. The consumer owns status results and denial messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment prerequisite** — mounting this plugin on an unrestricted host does not create a network boundary; the dedicated Linux runtime remains required.
- **Finite audit retention** — the gateway retains 1024 events. Consumers must detect overwritten cursors and stop rather than claim complete coverage.

<a id="dev-note"></a>
### Dev Note

None.
