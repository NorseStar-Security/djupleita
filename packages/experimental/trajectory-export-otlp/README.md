---
description: "Copy complete persisted trajectories to Logfire or another OTLP logs receiver with acknowledged checkpoints and offline recovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-export-otlp

English | [中文](README.zh.md)

## Summary

Export complete persisted trajectories as OTLP protobuf logs, without sampling or feedback. Run this opt-in consumer in an instructor-owned process. Successful acknowledgements advance private checkpoints; unavailable delivery retains local history for recovery. Full-content export requires explicit consent; default harness profiles are unchanged.

Add the optional `/traces` entry to export completed turn, model, tool, scope, and recorded event spans alongside the full log copy. Stable projected identities let a compatible OTLP trace receiver display turn nesting without changing the agent's behavior.

## Table of Contents

- [Use this package](#use-this-package)
- [Add completed traces](#add-completed-traces)
- [Delivery and recovery](#delivery-and-recovery)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount a persistence provider and this consumer in a dedicated `dsh` profile. The [instructor deployment](../../../course/trajectory-collector/README.md) supplies the profile and secret-file mount. Fields and defaults are generated in the [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-trajectory-export-otlp).

For multi-installation intake, mount `@deepseek-ai/dsh-experimental-trajectory-export-otlp/collector` instead of this package's root entry, with a [collector storage provider](../trajectory-collector-sqlite/README.md). Both entries use the same delivery settings; the collector entry requires `trajectoryCollector`, not session persistence. `collectorBatchBytes` defaults to 4 MiB and must not exceed the storage provider's read budget; `eventsPerSession` bounds the collector page length. A complete record that cannot fit stops export rather than being skipped.

```yaml
- insert:
    - name: '@deepseek-ai/dsh-session-persistence-jsonl'
      config:
        root: /var/lib/course-sessions
        compression: none
    - name: '@deepseek-ai/dsh-experimental-trajectory-export-otlp'
      config:
        endpoint: https://logfire-us.pydantic.dev/v1/logs
        tokenFile: /run/secrets/logfire_write_token
        stateDir: /var/lib/trajectory
        sourceId: instructor-assigned-archive-id
        allowFullContent: true
```

The endpoint includes `/v1/logs`. Select the project's region and a write-only token; the [Logfire OTLP guide](https://pydantic.dev/docs/logfire/migrate/overview/) documents Bearer authorization. Tokens are read from the private file on every request, allowing rotation without reload. Profiles, environment variables, status files, and diagnostics contain no token value. Source content is not redacted: prompts, reasoning, tool arguments/results, persisted model streams, errors, and plugin audit data may contain secrets. Use lab accounts, approved retention, and explicit collection consent. `sourceId` is an instructor-assigned namespace, not authenticated student identity.

<a id="add-completed-traces"></a>
## Add completed traces

Mount the [collector-derived projection](../trajectory-projection/README.md), then mount `@deepseek-ai/dsh-experimental-trajectory-export-otlp/traces` in the same instructor process. Set `endpoint` to the receiver's HTTPS `/v1/traces` URL, `tokenFile` to its private rotating Bearer token file, `sourceId` to the archive namespace, and `allowFullContent: true`. Give this entry its own `stateDir`; never share it with either logs entry. The trace entry requires `trajectoryProjection`, not session persistence. Existing log mounts remain unchanged.

The entry reads immutable completed spans only. It preserves the projection's deterministic trace/span IDs, millisecond timestamps, actual within-turn parent IDs, trusted installation identity, and selected recorded facts. It marks recorded blocked/error spans as OTLP errors. Open turns do not appear as completed root spans until settlement. This is a navigation view, not a replacement for the complete original logs or binary attachments.

`spansPerPage` defaults to 128 and `pageBytes` to 4 MiB; both must fit the projection's read limits. Each complete span uses one request, bounded by `maxRequestBytes` (256 KiB by default). An excessive page or span stops export rather than clipping facts or skipping a completion. Shared response, timeout, retry, token rotation, cancellation, and health-file behavior follows the logs entry below.

`stateDir/traces.json` advances only after a complete OTLP success response and binds the cursor to the endpoint, source namespace, and durable projection generation. A replaced projection or an impossible cursor stops export. Trace acknowledgements never advance the collector's primary log-export cursor. Retain this private checkpoint and the projection: deliberately starting with a new checkpoint replays completed spans with the same IDs, but does not promise receiver-side deduplication. Host crashes and lost acknowledgements can also replay spans.

Child-session IDs and parent trace IDs are exported as association attributes when the immutable projection row contains that evidence. A parent trace ID alone does not identify the initiating parent span, so the exporter does not invent an OpenTelemetry Link or cross-trace parent. Late catalog evidence does not rewrite already completed spans. Private loopback tests verify protobuf nesting, associations, retry/restart, and rejection handling; an instructor must separately verify the chosen remote receiver with its credentials.

<a id="delivery-and-recovery"></a>
## Delivery and recovery

The consumer discovers all sessions exposed by `ctx.sessionPersistence`, including inactive and child sessions. It reads validated logical headers/events through read handles and never appends, migrates, deletes, or takes write ownership. Use an OS read-only source mount as additional protection. Compressed archives require the provider's matching compression setting; historical generations use the provider's current logical interpretation, not their original file bytes.

A header uses sequence `-1`; events retain their canonical sequence and timestamp. Attributes include `dsh.source.id`, `dsh.session.id`, `dsh.event.seq`, `dsh.event.type`, and stable `dsh.record.id`/`dsh.record.sha256`. Records larger than `fragmentBytes` become ordered base64 fragments with `dsh.record.part` and `dsh.record.parts`. Reconstruct exact JSON UTF-8 bytes by deduplicating part identities, ordering parts, concatenating decoded bytes, and checking SHA-256. Ordinary records have readable JSON bodies. No content is silently clipped.

The collector entry adds server-trusted `dsh.course.installation.id`, `dsh.course.student.id`, and `dsh.course.cohort.id` separately from the unchanged record body. Durable intake receipts supply record IDs, separating colliding session IDs across installations. Student-supplied event attributes cannot replace this identity. Only complete successful remote delivery advances the store's durable primary-export cursor. The store binds that cursor to the destination fingerprint even when the exporter checkpoint directory changes. Local binary objects are not sent to OTLP.

Every part must receive a valid complete OTLP success response before its record's checkpoint advances. Timeouts and lost acknowledgements can duplicate records: delivery is at least once, not exactly once or Logfire-side deduplication. Network failures and HTTP 429/502/503/504 retry with exponential jitter and `Retry-After`. Partial rejection, other HTTP statuses, invalid acknowledgements, changed sources, and corrupt checkpoints stop export visibly without advancing the affected record. The [OTLP specification](https://opentelemetry.io/docs/specs/otlp/) prohibits automatically retrying partial rejection.

Inspect `stateDir/health.json` and console logs. `retrying` means delivery is unavailable; `failed` requires instructor investigation and reload after repair; `stopped` marks drained cancellation. `idle` means a scan completed, not that new events cannot arrive. Checkpoint or health-file write failures stop dependent export and produce console errors. Startup and terminal worker failures request exit code 1 through the launcher's existing `appExit` hook when present; an embedding host without that hook must monitor health and logs. Retain the source archive until receipt is verified; alert on disk exhaustion and prolonged lag. Source retention is not managed here.

Checkpoint replacement is atomic but does not fsync; host crashes can roll a checkpoint back and replay accepted data. Checkpoints bind to the endpoint, source namespace, and fragment size. Changed settings require a reviewed replay with a new private state directory, potentially duplicating remote data. Run one collector per state directory on one host/PID namespace. The event immediately before a cursor is checked on reopen; this is not whole-archive integrity attestation.

The owner lock records a PID, not a container identity. Abrupt termination can leave a stale lock; PID reuse, especially after container recreation, can prevent automatic takeover. Keep collectors using a shared state directory stopped, verify that no previous owner is running, and remove only `stateDir/owner.lock` before restarting. Never remove a live owner's lock or erase event checkpoints to clear contention. Sharing state between concurrently running PID namespaces is unsupported.

<a id="understand-the-implementation"></a>
## Understand the implementation

The existing persistence Service Definition and JSONL Service Provider are unchanged; this package supplies the Consumer role. An isolated OpenTelemetry logger and maintained protobuf serializers produce standard logs and optional traces without installing a global telemetry provider. Acknowledgement-aware transport owns bounded requests/responses, HTTPS, manual redirects, cancellation, and rotating file credentials. Lifecycle-owned workers serialize deliveries under separate same-host checkpoint locks, abort requests and retry waits on unload, close handles, and drain before returning. They neither use the best-effort live telemetry queue nor broaden the feedback-only backend's consent policy.

<a id="further-exploration"></a>
## Further Exploration

- [Persistence service](../../session/session-persistence/README.md) — read-handle and durability semantics.
- [JSONL provider](../../session/session-persistence-jsonl/README.md) — archive configuration.
- [Trace projection](../trajectory-projection/README.md) — deterministic span identities, recorded timing, associations, and query budgets.
- [Course enrollment proposal](../../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.md) — required connection and identity work.

<a id="model-experience"></a>
## Model Experience

None, as this consumer exports persisted events without adding prompts, tools, or session events.

#### KV Cache effect

No request tokens or request prefixes change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Logs preserve the full event copy; optional traces provide selected recorded metadata for a compatible receiver's waterfall. This package does not render a local dashboard, archive binary attachments, accept student uploads, or implement enrollment. Events never persisted before a crash cannot be recovered.
- One logical record is delivered at a time; large histories can lag. Memory and read costs also depend on the persistence provider, which may load a complete session. Wire budgets do not bound provider memory.
- Providers may omit unreadable session headers from listings and report them in their own logs. Monitor those diagnostics; an idle loop does not prove every source artifact was valid or discovered.
- Live Logfire delivery needs an instructor's endpoint/token and an acceptance run; mock-OTLP tests cannot establish vendor retention, limits, query behavior, or access controls.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
