---
kind: upgrade-guide
description: "Course runtime instructor deployments now deny host tool execution by default and require observed isolated-runtime readiness."
---

# Course research defaults to Isolated Linux

English | [中文](guide.zh.md)

## Change

Previously, selecting Local left course research tools available on the native host. The instructor `@deepseek-ai/dsh-experimental-course-runtime` plugin now defaults `allowHostResearch` to `false` and denies ToolRuntime execution on that host. The selector names locations Host management and Isolated Linux; returning to management does not grant research execution.

The root client opens Network Scope setup and enters Isolated Linux only after observed gateway health, action-review readiness, successful native trajectory intake, and matching saved/applied/running revisions. Unknown or failed observations never silently route research to the host. Existing processes and sessions are not moved or stopped by selector changes.

## Migration

1. Leave `allowHostResearch` absent or `false` on the instructor `course-runtime` Cordis row for course deployments. Its default-deny guard persists until the application root exits, including after plugin unload or Tools provider replacement. An instructor who intentionally permits trusted host research must set `allowHostResearch: true` in that deployment row and start a fresh application process; hot reload cannot reopen a process that already installed the denial. Browser drafts and the research role cannot enable it.
2. Open Network Scope through Host management. Configure target and operation policy, an approved action reviewer, and mandatory native trajectory collection. Build the runtime and explicitly apply the saved revision; review the confirmation when research is already running. See the [package configuration](../../../../packages/experimental/course-runtime/README.md).
3. Confirm that incomplete setup leaves Isolated Linux disabled and native tool calls return the management-only denial without a tool effect. After readiness is observed, confirm that root navigation enters `/runtimes/course/`. Returning to Host management must leave native tool execution denied.
4. Review existing native background processes separately before the course starts. This plugin installs a process-lifetime ToolRuntime denial in the instructor web composition; it does not retrofit operating-system isolation or rewrite unrelated headless profiles.
