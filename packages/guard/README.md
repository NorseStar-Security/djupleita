---
description: "Package map for loop and tool-execution guards, including repeat-call reminders, timeouts, and opt-in domain scope."
kind: "package-group"
---

# guard/ — loop and tool-execution policies

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps tool calls productive and within configured policy. `repeat-tool-reminder` reminds the model to change approach after repeated calls, and `timeout-policy` limits calls that declare a timeout. Both ship enabled in the `dsh` base bundle. The opt-in `scope-judge` blocks calls outside instructor-defined domains and denies tools whose destinations it cannot determine.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Choose the policies for your composition; each package reference explains configuration and limits.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`scope-judge/`](scope-judge/README.md) | Blocks out-of-scope domains before execution and denies unclassified tools |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration and the timeout-library decision behind the policy.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions the guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
