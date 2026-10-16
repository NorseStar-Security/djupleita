---
description: "Read-only scope policy inspection for swappable enforcement providers and judge/audit consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-network-scope

English | [中文](README.zh.md)

## Summary

Inspect instructor-defined network scope without granting new permissions. Consumers can check structured HTTP targets, observe readiness, and read an ordered environment audit feed. Choose a provider for the execution environment; the service does not install a firewall or run research tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount a concrete provider, not this abstract service. The course composition mounts [`network-scope-linux`](../network-scope-linux/README.md) and [`network-scope-guard`](../network-scope-guard/README.md). This package has no configuration.

Implement `NetworkScopePolicy.inspect(after, targets, signal)` to provide `ctx.networkScope`. An omitted cursor establishes the current position; later cursors read inclusive contiguous records. Providers must reject cancellation, malformed responses, immutable identity changes, and overwritten cursors with declared `NetworkScopeError` codes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [service definition](src/index.ts) separates policy inspection from the privileged enforcement process. The [types](src/types.ts) distinguish structured preflight targets from environment-wide traffic. No API can edit policy, approve an exception, or disable enforcement. Cordis owns provider lifetime and rejects duplicate service implementations.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — deployment, policy, and enforcement boundary.
- [Tools subsystem](../../../docs/subsystems/tools.md) — execution pipeline for native and PTC calls.
- [Testing policy](../../../docs/testing.md) — composition and recorded-Session evidence.

<a id="model-experience"></a>
## Model Experience

Indirectly, through scope-aware consumers that render policy status and operation denials.

#### KV Cache effect

The service contributes no prompt or schema and does not change the model prefix. Consumers own any logged model-visible result.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **External enforcement required** — an inspection service alone cannot constrain arbitrary code, browser background traffic, remote executors, or sockets.
- **Shared environment** — the current protocol describes one immutable Linux namespace policy, not per-Session or company-ownership authorization.

<a id="dev-note"></a>
### Dev Note

None.
