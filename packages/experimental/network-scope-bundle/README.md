---
description: "Add an optional first-party Network Scope page and protected runtime selector. The experimental bundle ships with DSH and remains disabled until explicitly selected. Its native controller validates policy through the gateway’s Python implementation."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-network-scope-bundle

English | [中文](README.zh.md)

## Summary

Add an optional first-party Network Scope page and protected runtime selector. The experimental bundle ships with DSH and remains disabled until explicitly selected. Its native controller validates policy through the gateway’s Python implementation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Enable Network Scope in Plugins and open Configure. Edit allowed domains, IPs/CIDRs, exclusions, infrastructure methods and paths, and HTTP(S) ports. Advanced holds lab pins and inspection settings. Save creates a pending revision; Apply stops research before selecting that immutable policy.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The Network Scope patch inserts course-runtime; its browser contribution registers the bundle Configure page and runtime selector. The native runtime owns activation and rejects disable or removal while protected research is active.

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
