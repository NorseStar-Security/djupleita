---
description: "Add an optional first-party Reconnaissance page to the protected course environment. The bundle remains experimental and requires Network Scope. Recon settings are fixed for each operation; discovering assets never grants authorization."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-recon-bundle

English | [中文](README.zh.md)

## Summary

Add an optional first-party Reconnaissance page to the protected course environment. The bundle remains experimental and requires Network Scope. Recon settings are fixed for each operation; discovering assets never grants authorization.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Enable Network Scope and Reconnaissance in Plugins, then open Reconnaissance. Configure passive sources, ports, rate, concurrency, depth, deadlines, and result limits. Advanced holds executable, proxy, resolver, and termination settings. Save and apply through the shared native controller.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The Recon patch inserts course-recon-ui; its host registration selects the recon composition and its browser registration owns the Configure page. The native runtime owns activation and rejects disable or removal while protected research is active.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Linux course runtime](../../../course/scope-runtime/README.md)
- [Experimental packages](../README.md)

<a id="model-experience"></a>
## Model Experience

None, as configuration and runtime control add no model prompts, tools, or Session events.

#### KV Cache effect

No direct effect; research providers and tools own their model-visible behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One shared policy and one protected ARM Colima environment are supported. Sessions and workspace volumes remain on their original backend. Switching does not migrate sessions or stop background work. Failed apply leaves research stopped; the user must review and apply again. Additional passive sources require explicitly reviewed infrastructure permissions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
