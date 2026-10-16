---
description: "Scoped reconnaissance service for replaceable discovery providers."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-recon

English | [中文](README.zh.md)

## Summary

Request an authorized recon operation and receive an inventory whose observations are explicitly distinguished from target permissions. Mount a concrete provider and a consumer; this abstract service does not execute tools or modify instructor policy.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount [ProjectDiscovery recon](../recon-projectdiscovery/README.md) and [recon tools](../recon-tools/README.md). There is no configuration for the abstract service.

Providers implement `catalog()` and `run(request, signal)`. Callers supply explicit targets, active-operation consent, and resolved file policy. Providers must authorize every target, bound execution and output, and wait for subprocess termination before settling cancellation. Inventory entries are observations, never scope grants.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The [service](src/index.ts) registers `ctx.recon`; the [types](src/types.ts) keep model schemas, sessions, and CLI flags outside the provider-independent API. Consumers own rendering and durable tool events.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — enforcement and deployment.
- [Tools subsystem](../../../docs/subsystems/tools.md) — execution and events.
- [Testing policy](../../../docs/testing.md) — composition and replay evidence.

<a id="model-experience"></a>
## Model Experience

Indirectly, through the recon-tools consumer that renders catalogs, inventories, and operation failures.

#### KV Cache effect

No direct prompt or schema contribution. Consumers own appended tool results and any reusable prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **External enforcement** — service authorization cannot constrain arbitrary code or nested network traffic; the course gateway remains required.
- **Inventory scope** — no persistent asset database, ownership inference, scheduler, or automatic discovery-to-scan pipeline.

<a id="dev-note"></a>
### Dev Note

None.
