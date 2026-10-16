---
description: "Persist turn traces and timed model, tool, and scope spans for bounded local trajectory inspection and independent OTLP trace export."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-projection

English | [中文](README.zh.md)

## Summary

Inspect collected agent work as turn traces with timed model, tool, and scope spans. Keep installation identity and recorded child relationships visible without attributing shared gateway traffic to a tool. Incremental SQLite indexing survives restarts and supplies bounded inspection and completed-span export pages. Original trajectory bytes stay in the collector; this read model is not source attestation or a replacement archive.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this provider beside a [collector storage provider](../trajectory-collector-sqlite/README.md) in an instructor-owned process. Give the projection its own absolute SQLite path in an owner-only directory. Never select the collector database itself. A Node.js runtime with `node:sqlite` and a local filesystem are required.

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-projection'
  config:
    path: /var/lib/trajectory-projection/projection.sqlite
```

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-trajectory-projection) lists polling, storage, span, and query bounds. Queries return complete pages or a visible size failure; reduce the requested item count when a page exceeds its byte budget. Trace search uses SQLite's ASCII case folding and literal substring matching, not SQL patterns. Newest and oldest pages use immutable exclusive cursors; refreshed status fields can change while identity ordering remains stable.

Read `status()` to distinguish indexing, idle, and terminal failure. A failed source, capacity check, or storage operation stops background indexing without advancing the affected record. The last committed view remains inspectable when storage is readable. Preserve both archives and repair the cause before a reviewed rebuild. Reload does not erase a persisted failure or reset the cursor.

The trace view contains selected metadata and first/last source cursors, not duplicate prompts, reasoning, arguments, or tool results. Retrieve complete evidence from the collector using its installation/session filters and bounded record pages. A blocked scope decision is explicit metadata. Shared-environment network observations remain shared-environment observations, not evidence that a specific tool caused a connection.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [provider](src/index.ts) commits source progress and derived rows in the same SQLite transaction with WAL and `synchronous=FULL`. It incrementally reads the collector; foreground queries never replay source history. Installation, Session, and turn identities determine stable OTel-compatible trace IDs. Span IDs include their trace and recorded invocation or sequence identity. Events outside a turn use an explicitly labeled Session-activity trace.

Tool calls open spans and their results close them. Model settlements use the earliest persisted stream-record timestamp, or settlement-only timing for an empty stream; this is not request-dispatch latency. Scope decisions and other events become recorded points. A turn end settles unfinished tool spans as incomplete. Backward wall clocks produce nonnegative durations with explicit `clockRegressed` and `recordedEndTime` metadata.

Session headers retain parent Session identity. A parent-owned child catalog can identify a parent trace only when it agrees with that header. Late catalog discovery enriches trace summaries without rewriting immutable completed export spans. No cross-trace parent span or network-to-tool causation is fabricated.

Completed spans receive persistent monotonic completion cursors and are never pruned or renumbered. Export consumers checkpoint this feed independently of collector log-export acknowledgements. A persistent projection-generation identity prevents a consumer from reusing a checkpoint after database replacement. The [tests](tests/projection.spec.ts) exercise real Loader composition, readback, replay identities, failure containment, quotas, and disposal to quiescence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Collector service](../trajectory-collector/README.md) — complete source records and trusted identity.
- [OTLP exporter](../trajectory-export-otlp/README.md) — separately acknowledged remote delivery.
- [Scope audit consumer](../network-scope-guard/README.md) — scope decision and environment attribution semantics.

<a id="model-experience"></a>
## Model Experience

None, as this provider reads collected evidence without adding model requests, prompts, tools, or Session events.

#### KV Cache effect

No request tokens or request prefixes change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Retain collector records until indexing and restart checks are complete. Unprojected gaps, cursor regression, and a changed or pruned restart anchor stop indexing. No silent recovery, source-generation fallback, migration, or automatic rebuild is provided.
- Metadata projection does not validate every owner-specific event field or attest student-controlled source data. It checks the fields it interprets; unknown event kinds remain visible points without invented model or tool semantics.
- SQLite work is synchronous. Storage quotas bound retained state; open-span limits bound turn settlement. Search and filtered listings can scan retained trace rows. Whole-page and span budgets do not provide streaming or a constant-memory source reader.
- Completed spans and their generation identity remain indefinitely. Retention, encryption, backups, multiple projection writers, and exact causal parent-span relationships require separate operational or domain support.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
