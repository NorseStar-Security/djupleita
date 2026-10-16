---
description: "Copy complete persisted sessions and optional attachment binaries into a trusted local trajectory collector; configure identity, bounded polling, and failure handling."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector-archive

English | [中文](README.zh.md)

## Summary

Copy persisted trajectories into a local collector without changing the source sessions. Include active, inactive, and child sessions, with full headers and complete event JSON. Restart safely using the collector's durable replay receipts rather than a second checkpoint database. Optionally copy referenced image and file bytes before acknowledging their events; this can include sensitive content and requires explicit configuration. Installation, student, and cohort labels come from trusted instructor configuration, not student authentication.

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

Mount this row in a composition that already provides `sessionPersistence` and `trajectoryCollector`, such as the [JSONL backend](../../session/session-persistence-jsonl/README.md) and [SQLite collector](../trajectory-collector-sqlite/README.md). This package is a consumer, not a research tool or a profile-installable bundle.

### When to choose it

Choose local archival when complete persisted records must remain inspectable independently of the agent, including after a process restart. Add the [collector OTLP exporter](../trajectory-export-otlp/README.md) separately for acknowledged remote record delivery. Do not use trusted local labels as evidence that a student authenticated, or expose local intake directly to untrusted uploads; the [HTTP collector](../trajectory-collector-http/README.md) owns that authorization boundary.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-archive'
  config:
    installationId: fixture-installation
    studentId: fixture-student
    cohortId: fixture-cohort
```

Replace these fixture labels with instructor-assigned deployment identity. Keep this configuration and the collector state outside the research agent's writable area. The row does not enroll students, obtain credentials, or grant network access.

| Field | Default | Meaning |
|---|---|---|
| `installationId` | required | Trusted local installation label |
| `studentId` | required | Trusted local student label, not an authenticated claim |
| `cohortId` | required | Trusted local cohort label |
| `copyAttachments` | `false` | Explicitly permit copying potentially sensitive image/file binaries through `attachments` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-trajectory-collector-archive) defines all polling, cache, byte, and traversal limits. Binary copying requires a mounted attachment provider. With copying disabled, event JSON still contains its original attachment references, but the archive makes no claim that those binaries were copied.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each scan enumerates persistence metadata, sorts session IDs consistently, and rotates through a bounded subset. Per-session event reads are bounded. A bounded in-memory revision cache avoids reopening unchanged logs; eviction and process restart replay through durable collector receipts without duplicating records. Collector conflicts stop intake rather than replacing previously committed evidence.

The header record uses sequence `-1`, type `session/header`, the header's `createdAt`, and exactly `JSON.stringify({header,inheritedEventCount})`. Subsequent records retain each event's sequence, type, timestamp, and `JSON.stringify(event)` bytes. This archives the persistence provider's current logical values, including inherited events; it does not rewrite or flush source logs and does not sort JSON keys.

When binary copying is enabled, bounded traversal finds structured `{type: 'image' | 'file', attachment: ...}` parts anywhere in an event. Reads use only `attachments.readImage` or `attachments.readFileStream`, never arbitrary paths or URLs. Declared size, actual size, and SHA-256 must agree before the binary is committed, and the containing event is acknowledged only afterward. Binary storage names use the digest so identical bytes with different display names can deduplicate; original names remain in the event JSON.

A source, attachment, or collector failure stops the worker, emits an actionable error without private diagnostics, and requests `appExit(1)` when the host provides it. An embedded host without that hook must monitor error logs. A committed prefix may remain; restore the failing dependency and reload the plugin to replay safely. Disposal cancels reads and timers, then drains an already-started collector commit and closes its read handle before completion.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Configuration and plugin lifetime |
| [`src/archive.ts`](src/archive.ts) | Read-only polling, revision cache, and record acknowledgement |
| [`src/attachments.ts`](src/attachments.ts) | Bounded attachment discovery, reads, and integrity checks |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Persistence seam](../../session/session-persistence/README.md) — source read handles and revisions.
- [Collector seam](../trajectory-collector/README.md) — record receipts, identity, and binary storage.
- [SQLite collector](../trajectory-collector-sqlite/README.md) — private durable local evidence.
- [OTLP export](../trajectory-export-otlp/README.md) — acknowledged remote record delivery.
- [Course collector deployment](../../../course/trajectory-collector/README.md) — instructor operation and authentication assumptions.

<a id="model-experience"></a>
## Model Experience

None, as this package reads persisted sessions and copies archive data without adding model requests, tools, prompts, or Session events.

#### KV Cache effect

Archiving leaves model context unchanged and preserves any existing reusable prefix; provider cache behavior remains outside this package.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The archive is read-only evidence collection, not an authentication or attestation service.

- Trusted local identity requires instructor-controlled configuration. A student controlling the source machine can suppress or fabricate logs; enrollment and automatic student upload are not implemented here.
- Only sessions exposed by the persistence provider's listing are archived. Unpersisted live chunks, omitted corrupt or unsupported headers, physical historical generations, and compressed source files are not backed up as raw filesystem artifacts.
- Binary copying is disabled by default and covers canonical image/file parts only. Tool-output strings, arbitrary paths, spill files, external URLs, and other unreferenced files are not copied. Byte or traversal exhaustion stops intake before acknowledging the affected event; raise the appropriate budget or repair the source before replaying.
- Polling adds delay and enumerates all session metadata even though visited sessions, event reads, cached cursors, and attachment traversal are bounded. Whole record JSON is not clipped; collector quota or size refusal stops intake.
- A failure can leave a committed prefix and requires operator repair and plugin reload. Disposal waits for in-flight collector operations, so its completion depends on the mounted collector settling them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
