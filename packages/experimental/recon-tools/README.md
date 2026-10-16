---
description: "Expose passive-first recon catalogs and explicitly authorized component runs to the model."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-recon-tools

English | [中文](README.zh.md)

## Summary

Ask the model to inspect available reconnaissance operations, select approved targets, and run one bounded operation at a time. Inventories and failures use ordinary tool results, so the existing trajectory collector can retain and export them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount [ProjectDiscovery recon](../recon-projectdiscovery/README.md), then add this row to the composition. There is no plugin configuration.

```yaml
- name: '@deepseek-ai/dsh-experimental-recon-tools'
```

The composition must provide `recon`, `tools`, and `sandboxPolicy`. Use `recon_catalog` first; use `recon_run` with an explicit component, target list, and `allowActive` boolean. The provider, not model consent, decides scope. Results marked out of scope must not be used as later targets without an independent instructor grant.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The [consumer](src/index.ts) resolves file policy from the calling session and delegates execution to `ctx.recon`. Cordis owns both registrations and removes them on unload. Standard tool cards display arguments and JSON text results; there is no custom client renderer or agent-loop change. Persisted `tool/call` and `tool/result` events feed the existing full-trajectory exporter without a separate telemetry path.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — enforcement and deployment.
- [Tools subsystem](../../../docs/subsystems/tools.md) — execution and events.
- [Testing policy](../../../docs/testing.md) — composition and replay evidence.

<a id="model-experience"></a>
## Model Experience

### Tool schemas and results

#### What the model sees

[recon_catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-recon-tools) and [recon_run](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-recon-tools) own the schemas. Results contain catalog entries or JSON with targets, policy hash, coverage flags, and asset observations; failures are ordinary tool errors.

#### Token effect

The two tool schemas are fixed context while mounted. Catalogs and provider-bounded results append per call; no system-prompt text is added.

#### KV Cache effect

Tool results are append-only. Mounting, unloading, or changing the tool schemas can replace the schema prefix; repeated calls do not rewrite earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No orchestration agent** — passive-first guidance does not automatically schedule a multi-stage campaign; each operation remains explicit.
- **External enforcement** — removing this consumer removes its tools, not the gateway; arbitrary terminal/browser capabilities still require the shared Linux network boundary.

<a id="dev-note"></a>
### Dev Note

None.
