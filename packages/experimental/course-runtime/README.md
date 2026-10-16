---
description: "Configure Scope and Recon from either runtime while keeping deployment control on the native Mac. Save creates a pending revision; applying selects an immutable configuration after stopping all research processes. This package remains experimental."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-course-runtime

English | [中文](README.zh.md)

## Summary

Configure Scope and Recon from either runtime while keeping deployment control on the native Mac. Save creates a pending revision; applying selects an immutable configuration after stopping all research processes. This package remains experimental.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Enable the Network Scope bundle from Plugins, then open its page. Save the target policy, operation restrictions and action-review configuration, select an instructor-approved reviewer model, build the ARM runtime, and apply the pending revision. A running environment requires Stop and apply. Empty operation or reviewer settings do not authorize research. Apply inherits enabled native bundles, model routes and their product-stored API keys, preserving subsequent isolated model overrides. Configure overrides in the selected backend’s Settings → Models; account sign-ins need separate authentication. Native environment forwarding remains limited to the explicit OPENAI_API_KEY option.

The native app defaults to Host management: its ToolRuntime calls are denied, and the root client opens setup until Isolated Linux has observed gateway health, action-review readiness, successful trajectory intake, and identical saved/applied/running revisions. It then navigates to the isolated client without silently falling back to host execution. Return through Host management to edit scope or inspect native settings; this navigation does not grant tool execution. Each location retains separate browser state. Unknown or failed observations disable isolated selection; the label is a location, not a safety certification.

Deployment owners may set `allowHostResearch: true` on the instructor `course-runtime` Cordis row before starting a fresh process to permit trusted host research. The default is `false`; the browser draft cannot change it, and the research role cannot enable it. Once default-deny instructor mode mounts, unloading or reconfiguring the plugin cannot remove its process-lifetime host guard; changing this escape requires an application restart. A fresh explicit opt-in omits only this package’s denial, not other guards or network policy. `archivePollIntervalMs` defaults to 2500 ms (range 1000–60000). Existing processes are not migrated, killed, or retroactively confined by changing the selector. See the [host-management migration](../../../docs/upgrade-guide/v0.2.1-alpha.3/course-runtime-host-management/guide.md) before upgrading an existing course deployment.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The native controller stores drafts, immutable revisions, operation state, and generated Compose configuration under the ignored harness-local home. A revision fence rejects stale saves; an older status poll cannot replace a newer saved editor revision. A process lock serializes lifecycle operations. HTTP and WebSocket bridges authenticate against the native connection and forward only a separate research credential. Research receives a read-only policy and no Docker socket. Private launch snapshots travel over owned process stdin and an immutable configuration volume; browser status never includes model keys. The bootstrap retains YAML tags outside imported fields and stores the previous import privately for three-way merging.

Mandatory native intake pulls bounded, authenticated, read-only persisted records into the instructor collector under a distinct installation identity. Only a complete durable poll renews the gateway’s native-only archive lease; new reviewed tool admission fails closed before the first renewal or after expiry. The course default lease is 30 seconds, configurable as `actionReview.archiveLeaseSeconds`. Intake or renewal failure is visible and requests a runtime stop. Unloading a required collector/projection/configuration seat drains in-flight receipts and requests a stop if research is running; if stop confirmation fails, the bounded gateway lease still expires. Neither native cookies nor collector write credentials enter research. These complete records originate in the research worker: they are not tamper-proof independent observation of every process or network action, and this puller does not copy attachment binaries.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md)
- [Experimental packages](../README.md)

<a id="model-experience"></a>
## Model Experience

Indirectly, through ToolRuntime results: native tool calls receive `Native host research is disabled. Configure and use the Isolated Linux runtime; the host is management-only.` by default. The isolated research composition does not receive this host guard; its scope and action-review plugins own their results. This package adds no model requests or tools.

#### KV Cache effect

No system-prompt prefix changes. A denied native call adds a normal tool-result message to the session; research providers and tools own their other cache effects.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One shared policy and one isolated ARM Colima environment are supported. Sessions and workspace volumes remain on their original backend. Switching does not migrate sessions or stop background work. Failed apply leaves research stopped; the user must review and apply again. Additional passive sources require explicitly reviewed infrastructure permissions.
- Native admission covers calls through ToolRuntime; it is not an operating-system sandbox and does not rewrite unrelated headless profiles. Once default-deny instructor mode mounts, its denial survives plugin unload and Tools provider replacement until the application root exits. Archive lease expiry denies new reviewed tool admission; it does not undo an already-running tool’s external effects.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
