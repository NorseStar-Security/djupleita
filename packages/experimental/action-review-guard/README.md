---
description: "Require a trusted durable review before every native, outer/inner PTC, MCP, and child-agent tool body."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-action-review-guard

English | [中文](README.zh.md)

## Summary

Keep research capabilities usable while requiring a separate review for every executable tool action. Native tools, outer and nested PTC calls, MCP tools, and child agents all use the same guard. A denial, missing Session, failed audit, unavailable reviewer, or removed guard blocks dispatch. Permission presets cannot override this requirement.

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

Mount this consumer beside the existing tools, [`network-scope-linux`](../network-scope-linux/README.md), and [`action-review-linux`](../action-review-linux/README.md) services in the dedicated Linux course composition. It has no permission-preset, exemption, approval, or deployment-budget settings.

```yaml
- name: '@deepseek-ai/dsh-experimental-network-scope-linux'
- name: '@deepseek-ai/dsh-experimental-action-review-linux'
- name: '@deepseek-ai/dsh-experimental-action-review-guard'
```

The guard activates as soon as tools exist, including when either required provider is initially absent. Each call freshly inspects network readiness, verifies that review status belongs to the same gateway and policy, submits the full action, and appends the trusted receipt to its Session before delegation. Agentless requests have `sessionId: null` and cannot execute, including when an erroneous reviewer returns allow. This baseline has no instructor approval path.

Transport failures deny the affected call without reusing an earlier allow. Invalid responses, identity changes, or failed Session audit close future admission. Unloading the guard or a required provider leaves a root-lifetime denial latch, including after remount; the instructor must investigate, restore the required services, and restart the process. Already-running tool bodies are not retroactively terminated.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [consumer](src/index.ts) uses the existing pre-execution waterfall and monotonic tool guard, without modifying the agent loop or individual adapters. Its permit is associated with the exact registry-created execution object. A later permissive listener cannot replace a missing or denied review. Nested calls bind their known parent call identity through the runtime's opaque parent token.

The [records](src/types.ts) retain decisions and final dispatch outcomes separately. The external receipt acknowledges trusted durable storage; the Session copy must commit synchronously before execution. A failed outcome append closes subsequent admission but cannot undo a body that already ran. Consumer teardown aborts and drains pending reviews; the application root retains the tools watcher and closed guards on both stale and replacement registries until process restart.

The [real Loader fixtures](tests/loader.spec.ts) observe tool-body counters, complete request bytes, per-call receipts, child Sessions, PTC sub-dispatch, cancellation, storage failure, and mandatory unload behavior. They model a local gateway and external program runtime; Linux containment and real evaluator accuracy need their independent deployment checks.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md) — deployment and trusted review configuration.
- [Tools subsystem](../../../docs/subsystems/tools.md) — native and nested dispatch.
- [Testing policy](../../../docs/testing.md) — composition and output evidence.

<a id="model-experience"></a>
## Model Experience

### Dispatch denials

#### What the model sees

Denied calls return `Action review denied tool dispatch (${code}).` through the normal logged tool-result surface. Missing Session uses `Action review denied tool dispatch (ACTION_CONTEXT_REQUIRED); a trusted Session is required.` Closed admission uses `Action review admission is closed; restore required services and restart the process.` The tool runtime adds its normal error prefix. No additional prompt or schema is registered.

#### Token effect

Each denied call adds a short tool result. Decision findings and receipts are log-only plugin records and add no conversation tokens. Trusted reviewer evaluation requests have separate deployment-owned cost.

#### KV Cache effect

Results append to retained history and preserve the earlier conversation prefix. Guard load and unload do not change tool schemas; unloading still closes admission until restart.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Containment remains mandatory** — reviewing a script does not intercept its individual subprocesses, redirects, or browser background traffic; retain lower destination and operation enforcement.
- **Restart after removal** — this mandatory consumer is intentionally not hot-unloadable into unrestricted access. Restoring a removed guard requires an instructor-controlled process restart.
- **Trusted process assumption** — arbitrary same-process code or a host administrator can bypass plugin APIs; this is not a security boundary against either.

<a id="dev-note"></a>
### Dev Note

None.
