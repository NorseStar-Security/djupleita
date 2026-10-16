---
description: "Inspect locally collected agent trajectories in the Web GUI with bounded trace searches, execution trees, timelines, and exact source records."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-viewer

English | [中文](README.zh.md)

## Summary

Open **Trajectories** in the Web sidebar to inspect collected research sessions without loading whole transcripts. Filter by installation, student, cohort, session, status, or trace text, then inspect an execution tree or timed spans. Pause live following, replace pages, and open complete source records as inert text. Connection failures and projection lag remain visible. The viewer uses the existing Web connection authentication and grants no research or upload capability.

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

Mount the plugin beside an existing authenticated Web application, [collector](../trajectory-collector-sqlite/README.md), and [trace projection](../trajectory-projection/README.md).

### When to choose it

Choose the viewer for local course observation and source inspection. Use [OTLP export](../trajectory-export-otlp/README.md) separately for remote Logfire queries and cross-machine monitoring. Keep the instructor Web authentication, archive identity configuration, and databases outside the research agent's writable area.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-viewer'
```

This package is not an installable profile bundle. The [course overlay](../../../course/trajectory-collector/README.md) composes its dependencies without replacing existing persistence or Web authentication. The browser client loads through the plugin's declared `dsh.client` entry. Course Runtime uses the `/native-management` export as a browser-only attachment in Protected; it publishes the native API path without mounting archive services in research.

| Field | Default | Meaning |
|---|---|---|
| `apiBasePath` | `api/trajectory-viewer/` | Same-origin backend path; `/api/trajectory-viewer/` selects native management from Protected |
| `pollIntervalMs` | `1500` | Delay between settled live reads, from 1000 to 60000 ms |

The read-only `/api/trajectory-viewer/status`, `/traces`, `/detail`, and `/records` routes require the existing connection credential. Queries admit at most 100 rows, reject unknown or repeated parameters, and cap complete responses at 2 MiB. Source reads additionally request at most 1 MiB. Oversized records fail visibly rather than being clipped. No upload or control route is added.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The Host authenticates each bounded read before accessing the collector or projection. It admits eight concurrent reads and responds with a timeout after ten seconds while retaining ownership of an unfinished provider read. Teardown stops admission and drains those reads. Provider diagnostics never appear in HTTP failures.

The browser registers a framework resource provider; components do not fetch or subscribe directly. Held live resources use the configured polling cadence, and release aborts their requests and timers. Paused pages read once; refresh creates a new resource request. Failures keep the last value marked stale. Pagination replaces rows instead of growing the DOM indefinitely. Parent/child session navigation retains the selected installation identity.

Trees and timelines describe the current page of indexed spans, not a promise that all descendants are loaded. Source inspection reads complete collector JSON and renders it as text, never HTML. Its search examines only the visible record page. No source Session is rewritten.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Route registration and lifetime |
| [`src/http.ts`](src/http.ts) | Authentication, query limits, and read settlement |
| [`src/wire.ts`](src/wire.ts) | Browser response validation |
| [`src/client/resources.ts`](src/client/resources.ts) | Polling and cancellation |
| [`src/client/viewer.tsx`](src/client/viewer.tsx) | Bounded tree, timeline, filters, and source presentation |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Course collector deployment](../../../course/trajectory-collector/README.md) — local startup and authentication assumptions.
- [Trace projection](../trajectory-projection/README.md) — timing, status, and child-session evidence.
- [Local archive](../trajectory-collector-archive/README.md) — complete persisted record intake.
- [SQLite collector](../trajectory-collector-sqlite/README.md) — durable storage and retention.
- [OTLP export](../trajectory-export-otlp/README.md) — optional remote logs and traces.

<a id="model-experience"></a>
## Model Experience

None, as this package presents collected records to humans without adding model requests, tools, prompts, or Session events.

#### KV Cache effect

The viewer leaves model context and its reusable prefix unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The viewer is a bounded local inspector, not a real-time packet observer or student enrollment service.

- Live following observes persisted collector/projection state, with intake and indexing delay; it does not display unpersisted token chunks.
- Trace text search covers indexed summaries. Raw JSON search covers only the loaded source page. Trees may show page-local roots when a parent is on another page.
- Large pages or individual source records can exceed the response budget and require a smaller API page or separate collector export; data is never silently truncated.
- All authenticated users of this Web connection can inspect the mounted collector. Per-student remote authorization and course SSO are not implemented here.
- Timeline accuracy is limited to recorded timestamps. The projection documents unavailable timing and shared-environment scope attribution.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
