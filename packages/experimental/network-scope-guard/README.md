---
description: "Compose destination-aware tool preflight, scope_status, and Session network audit without capability denylists."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-network-scope-guard

English | [中文](README.zh.md)

## Summary

Keep browsers, terminals, code execution, and scanners available behind an instructor-enforced network boundary. Inspect known HTTP target arguments before dispatch and block destinations outside scope. Read the current policy with `scope_status` and retain environment network decisions in Session logs. Unknown tool names remain usable; the external gateway constrains their actual traffic.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this consumer inside the [course runtime](../../../course/scope-runtime/README.md) with the [`network-scope-linux`](../network-scope-linux/README.md) provider. Do not also mount the legacy argument-only scope judge in that profile: it intentionally denies opaque capabilities.

```yaml
- name: '@deepseek-ai/dsh-experimental-network-scope-linux'
- name: '@deepseek-ai/dsh-experimental-network-scope-guard'
```

| Field | Default | Meaning |
|---|---|---|
| `pollIntervalMs` | `1000` | Background health/audit inspection interval in milliseconds |
| `targetTools` | Fetch and browser navigation mappings | Exact tool name, top-level `urlField`, and optional-argument `methodField`; absent method means `GET` |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-network-scope-guard) owns the exact default mappings, including the Playwright MCP tool name. Each call gets fresh readiness inspection. Mapped targets also receive an authoritative gateway decision before their tool body executes. Unmapped calls are allowed through this judge, not exempted from the kernel/gateway policy. Nested PTC dispatch uses the same pipeline.

Transport or unhealthy-gateway failures deny tool dispatch until inspection succeeds. Changed gateway identity, malformed observations, overwritten audit cursors, and failed audit storage stop dependent dispatch; the instructor must investigate before reload. Reloading does not change the external policy. Already-running opaque programs are not killed by this plugin when the gateway fails; persistent kernel rules remain their network constraint.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [consumer](src/index.ts) serializes preflight and polling through one audit cursor. A monotonic tool guard makes a later permissive listener unable to override this consumer's denial. The provider owns immutable policy decisions; the consumer never parses shell programs or edits a firewall. Cordis unload removes the guard, tool, and listeners, cancels pending inspections, and drains polling.

The [experimental records](src/types.ts) separate actual pre-dispatch judge decisions, which have a tool call id, from environment network activity, which deliberately has none. Each live Session receives the shared feed observed while the consumer runs; a newly attached Session can receive activity since the last environment poll. Initial attachment starts at the current gateway cursor. Old readers retain and skip these ignorable records; they do not affect model context. They are not a tamper-proof or complete forensic ledger, and migrations retain them only best-effort.

The [Loader tests](tests/loader.spec.ts) verify dispatch effects, failure closure, audit retention, and unload. The [keyless CLI scenario](../../../snapshots/session/network-scope/snapshot.yml) records policy output, a real terminal positive control, and an out-of-scope fetch denial. The separate Linux suite owns actual socket/browser confinement evidence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Scope service definition](../network-scope/README.md) — replaceable provider and consumer API.
- [Linux course runtime](../../../course/scope-runtime/README.md) — policy, deployment, and trust assumptions.
- [Tools subsystem](../../../docs/subsystems/tools.md) — native and PTC dispatch.

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The [generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-network-scope-guard) owns the exact `scope_status` schema. This package adds no hidden system prompt or automatic policy instructions.

#### Token effect

One fixed tool schema is present while the consumer is mounted. Environment audit records add no model tokens.

#### KV Cache effect

The schema is stable during a mount. Adding or removing this consumer changes the tool header and can invalidate reuse from that position.

### Status and denial results

#### What the model sees

`scope_status` returns JSON containing gateway instance, policy hash, boundary, and instructor policy. Preflight failures return tool errors naming the decision code or unavailable preflight; policy and error results use the normal logged tool-result surface. Network denials inside an already-running program remain that program's output, not retroactive tool-judge verdicts. Dispatch errors use `Network scope denied tool dispatch (${code}); inspect scope_status or ask the instructor to restore the boundary.`, where `${code}` is the failed decision. Missing preflight uses `Network scope preflight did not complete; tool dispatch is blocked.`; degraded state uses `Network scope is unavailable; tool dispatch is blocked.`. The tools runtime adds its normal error prefix.

#### Token effect

Status size depends on the policy. Denials add short tool-result text. Both append to retained conversation history; the log-only network feed does not.

#### KV Cache effect

Results grow context append-only and preserve an earlier reusable prefix. A changed policy requires a new environment identity and instructor-controlled reload, not replacement of earlier messages.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Deployment is the security boundary** — the consumer can be unloaded by agent-owned code; the external instructor-owned firewall cannot. Never treat plugin checks alone as confinement.
- **Partial argument inspection** — only configured top-level HTTP target fields receive pre-dispatch destination checks. Redirects, arbitrary code, background browser traffic, and raw IP traffic are enforced below tools; network audit cannot reliably assign them to one call or Session.
- **Shared, bounded audit** — all live Sessions share the environment feed. A flood can overwrite the 1024-event gateway ring and deliberately stop further tool dispatch. Instructor gateway stdout remains the independent audit source.

<a id="dev-note"></a>
### Dev Note

None.
