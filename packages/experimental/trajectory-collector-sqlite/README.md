---
description: "Durable local SQLite trajectory storage with trusted identity, replay protection, binary evidence, and acknowledged retention."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector-sqlite

English | [中文](README.zh.md)

## Summary

Store complete course trajectories and binary evidence on instructor-owned local disk. Exact replays return the original receipt; conflicting content or identity fails without replacing evidence. SQLite commits preserve sequence, revocation, and export progress across restarts. Authentication and student enrollment require separate providers and are not supplied here.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this Service Provider in an instructor-owned process with [archive intake](../trajectory-collector-archive/README.md) or [authenticated HTTP intake](../trajectory-collector-http/README.md). The database path must be absolute. Its dedicated directory and existing database must belong to the process owner, without group or other permissions on POSIX systems. Keep this directory outside the research agent's writable workspace. Use a local filesystem and a Node.js runtime that supports `node:sqlite`.

```yaml
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
  config:
    path: /var/lib/dsh-trajectories/collector.sqlite
```

The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-trajectory-collector-sqlite) lists quotas, read budgets, and defaults. Size quotas include the complete submitted record envelope, live record content, binary objects, and conservative database write reservations. Inspection returns whole records within explicit item and serialized-page byte budgets. A record that cannot fit fails visibly; content is never silently clipped.

A trusted intake consumer supplies installation, student, and cohort identity independently of uploaded content. HTTP intake requires an authorization provider; archive intake uses instructor-configured identity. The first write binds an installation permanently to that identity. Revocation denies future writes, including replays, without deleting evidence. This storage provider does not accept credentials, enroll students, or grant network access.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [provider](src/index.ts) uses WAL mode, `synchronous=FULL`, parameterized queries, and synchronous transactions. A successful receipt follows commit. A native storage failure stops intake until reload and preserves the original cause in `COLLECTOR_STORAGE`. Quota, input, conflict, and revocation failures reject the operation without replacing committed content. The [real Loader tests](tests/collector.spec.ts) cover restart recovery, lock failures, exact filters, quotas, revocation, artifacts, and retained replay protection.

A session requires its complete `session/header` record at sequence `-1`, followed by contiguous original event sequences. Parsed JSON must match the envelope's session identifier, sequence, type, and timestamp. Raw JSON bytes and the full trusted identity/envelope determine replay equality. Binary objects require a matching SHA-256 digest and retain their bytes and display name per installation.

One primary export destination binds an immutable acknowledgement cursor. Acknowledgements cannot move backward or pass the latest committed record. Pruning clears only event content from an acknowledged, sufficiently old prefix. Headers, record identities, digests, installation bindings, and sequence high-water marks remain, so replay cannot overwrite pruned evidence or reuse sequence numbers. Binary objects are not pruned.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Collector service](../trajectory-collector/README.md) — storage and authorization contracts.
- [OTLP exporter](../trajectory-export-otlp/README.md) — acknowledged remote copies of complete records.
- [Instructor deployment](../../../course/trajectory-collector/README.md) — process isolation and deployment assumptions.

<a id="model-experience"></a>
## Model Experience

None, as this provider stores and reads evidence without adding model requests, prompts, tools, or Session events.

#### KV Cache effect

No request tokens or request prefixes change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Storage is not source attestation or encryption. Operate backup, filesystem access, disk monitoring, and encryption separately. Never copy only an active SQLite main file as a backup; its WAL can contain committed evidence.
- Pruning is logical retention, not secure erasure. Retained headers and deduplication tombstones still count toward the record quota. Capacity management must preserve those identities; deleting them would remove replay protection. Pruning reserves conservative WAL headroom for the whole database and can reject when storage is already tight; it does not run `VACUUM` or guarantee smaller files.
- Transactions block the process while SQLite works. Inspection can load up to the configured record-count bound before enforcing the serialized-page byte budget. Binary objects use bounded buffers, not streaming.
- One primary export destination is supported. No destination reset, schema migration, artifact deletion, student enrollment, production authorization provider, or automatic student uploader is implemented here.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
