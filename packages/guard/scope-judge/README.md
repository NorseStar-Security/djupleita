---
description: "Configure domain scope for course research tools and understand pre-execution denials, target adapters, and limits."
kind: "package-reference"
---

# @deepseek-ai/dsh-scope-judge

English | [中文](README.zh.md)

## Summary

Use the scope judge to keep research tool calls within instructor-defined domains. It blocks out-of-scope destinations before execution and returns a reason the agent can act on. Structured tools declare their destination fields; an optional Bash adapter checks literal `curl`, `nmap`, and `dig` commands. Unknown tools and indeterminate destinations are denied. This policy checks tool arguments; providers and the lab network must also constrain redirects, secondary requests, and traffic that arguments do not describe.

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

Mount the judge globally so its policy applies to every agent using the shared tool executor, including tools registered later.

Choose the [Linux course runtime](../../../course/scope-runtime/README.md) instead when arbitrary browser, code, terminal, or IP-scanner capabilities need destination-based enforcement. This package remains an argument-only guard with reviewed adapters, not a network boundary.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-scope-judge'
  config:
    domains: [example.test, '*.lab.test']
    shellTools: [bash]
```

| Field | Default | Meaning |
|---|---|---|
| `domains` | Required | Nonempty list of exact DNS names or `*.domain` descendant rules |
| `targetTools` | `[{ name: web_fetch, paths: [/url] }]` | Reviewed tool names and all required destination JSON pointers; supplying the list replaces the default |
| `shellTools` | `[]` | Reviewed one-shot Bash tools using a `command` argument |
| `localTools` | `[]` | Explicit exemptions for reviewed tools without network or arbitrary execution capabilities |

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-scope-judge) lists parser-level configuration. Empty scope, malformed rules or pointers, duplicate tool names, and conflicting classifications fail at load. The [course guide](../../../docs/user/guide/scope-judge.md) provides an opt-in profile patch.

### Domain matching

`example.test` authorizes only that name. `*.example.test` authorizes descendants at any depth and excludes the apex; list both when both are authorized. Matching normalizes case, one terminal DNS dot, and internationalized DNS names to ASCII, then compares complete DNS labels. `example.test.evil.test`, `evilexample.test`, and unlisted subdomains remain outside scope. IP literals, legacy numeric IP spellings, credentials, unsupported URL schemes, malformed ports, and ambiguous targets are denied. DNS resolution never grants additional scope.

<a id="structured-tools"></a>
### Structured tools

Each `paths` entry is a JSON pointer to a required destination string. A `*` segment selects every member of a nonempty array; `~1` and `~0` escape `/` and `~` in property names. All selected strings must be DNS hosts, hosts with numeric ports, or HTTP(S) URLs, and every hostname must be authorized. Missing paths, empty arrays, mixed string/non-string values, or one out-of-scope target deny the whole call.

```yaml
targetTools:
  - name: web_fetch
    paths: [/url]
  - name: mcp_lab_probe
    paths: [/requests/*/target, /callback/host]
```

Only map a tool after reviewing its implementation: the listed fields must describe every destination, and other fields must not execute code, select proxies, override hosts, or introduce additional requests. An allowed-looking argument does not establish where an arbitrary third-party tool connects. Keep unknown MCP tools denied until reviewed.

### Bash commands

The optional adapter accepts one literal command with ordinary quotes and these examples:

```sh
curl -q -I https://example.test
curl -q --max-time 5 https://example.test https://api.lab.test
nmap -sV -Pn -p 80,443 example.test
dig -r example.test A +short
```

`curl` requires `-q` or `--disable` first to suppress its configuration file. It accepts HTTP(S) destinations, basic display/protocol flags, request methods, literal data, and timeouts. Redirect-following, proxy, host/connection override, configuration-file, and output-file flags are denied. `nmap` accepts literal DNS targets, the documented scan/probe flags in [the adapter](src/shell.ts), numeric ports, timing templates, top-port counts, and retry limits; scripts, input files, IPs, ranges, and other options are denied. `dig` requires `-r` to suppress its configuration file and accepts one DNS name, common record types, and basic output flags; custom resolvers, tracing, and batch/reverse queries are denied.

Shell operators, substitutions, variable expansion, escapes, control characters, unquoted globbing, wrappers, and unsupported options are denied. Use only a trusted one-shot Bash provider with controlled startup files, environment, PATH, and binaries. Persistent terminals and arbitrary runtimes cannot establish their destinations from one command argument and remain unclassified. A normal approval grant cannot override a scope denial.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin compiles a private copy of its configuration, then registers a synchronous `ctx.tools.guard`. The tool executor invokes this monotonic check after pre-execution policies and approvals and before dispatch. The first denial prevents the tool body and around-dispatch listeners from running. The existing tool result and Session history carry the reason; the judge makes no auxiliary model request and adds no persistence format. Cordis removes the guard when its plugin fiber unloads. Multiple judges intersect their permissions.

| File | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Loader configuration and effect registration |
| [judge.ts](src/judge.ts) | Tool classification, required target extraction, and denial |
| [domain.ts](src/domain.ts) | DNS normalization and scope comparison |
| [shell.ts](src/shell.ts) | Finite literal-command adapters |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages for composition and executor details.

- [Course setup](../../../docs/user/guide/scope-judge.md) — activate the judge with an instructor-owned scope.
- [Tool execution pipeline](../../../docs/tool-execution-pipeline.md) — policy, approval, and dispatch ordering.
- [Tools package](../../core/tools/README.md) — monotonic guard semantics and finalized results.
- [Guard family](../README.md) — adjacent policies.

-----

<a id="model-experience"></a>
## Model Experience

### Denied tool result

#### What the model sees

A denied call returns `Error: scope judge denied "<tool>": <reason>. Allowed domains: <rules>`. An outside-domain reason is `target domain "<domain>" is outside scope`. Other reasons describe missing targets, unsupported commands, or unclassified tools. Allowed calls retain the tool's ordinary result. The judge does not change tool schemas or system prompts.

#### Token effect

No auxiliary inference or fixed prompt cost. Each denial adds one ordinary tool result whose length depends on the configured rules and tool name.

#### KV Cache effect

Denial results append to tool history without replacing earlier request tokens. Changing configuration changes later denial text; existing provider cache availability is outside this plugin's control.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The judge enforces the reviewed tool-argument policy, with these deployment requirements.

- Configuration, adapters, plugin code, shell environment, and binaries are trusted instructor assets. Do not grant the agent permission to modify or unload them; a `localTools` exemption bypasses destination checks for that tool.
- Domain identity does not constrain DNS answers, CNAMEs, redirects, browser subresources, background tasks, or secondary requests inside a provider. Use the built-in fetch provider's same-origin redirect enforcement and lab network egress controls. This plugin is not a network firewall.
- Unclassified search, browser interaction, code execution (`run_code`), terminal input, external subagents, and plugin-management tools are denied. Use native tool mode for the course patch. A custom structured adapter must be reviewed before enabling any of these capabilities.
- Configuration changes judge subsequent dispatches; unloading or narrowing scope does not terminate calls already running. Stop active work before changing an exercise's scope.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
