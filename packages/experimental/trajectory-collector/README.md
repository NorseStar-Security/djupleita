---
description: "Durable course trajectory intake, binary evidence, inspection, and replaceable student-upload authorization."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector

English | [中文](README.zh.md)

## Summary

Retain complete course trajectories locally and inspect them independently of the research agent. Exact replays receive the original receipt; conflicting records fail instead of replacing evidence. Keep trusted installation, student, and cohort identity separate from uploaded content. Student uploads require an authorization provider; no shared image secret or anonymous fallback is supplied.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount a concrete provider, not this abstract service. Use [SQLite storage](../trajectory-collector-sqlite/README.md), [trusted archive intake](../trajectory-collector-archive/README.md), and optionally [authenticated HTTP inspection and ingestion](../trajectory-collector-http/README.md). This definition has no configuration. It adds no research tools or network grants.

Storage acknowledges only complete committed records. A session starts with sequence `-1`, type `session/header`, and JSON containing `{header,inheritedEventCount}`; subsequent events preserve their original sequence, type, timestamp, and complete JSON bytes. Binary objects use checked SHA-256 identities. Inspection returns complete records within explicit item and byte budgets; it never silently clips content.

Keep authorization and enrollment outside the research process. `TrajectoryUploadAuth` verifies course-issued credentials and supplies the trusted installation/student/cohort identity; absence rejects HTTP uploads. `TrajectoryCredentials` defines installation-side retrieval of current short-lived credentials, but has no production provider or uploader yet. Course SSO, service hostname, enrollment, renewal, and sender-constrained credentials remain deployment placeholders, not working authentication. Local archive identity is instructor configuration, not verified student identity.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [service definitions](src/index.ts) keep storage, upload authorization, and installation credentials replaceable. Consumers cannot derive trusted identity from event attributes. The [values](src/types.ts) distinguish original records, durable receipts, bounded inspection pages, and binary data. One primary export destination owns a durable acknowledgement cursor; retention can remove only an acknowledged old prefix while retaining replay protection. Revocation rejects future writes without deleting evidence.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [OTLP exporter](../trajectory-export-otlp/README.md) — acknowledged remote record copies.
- [Course collector](../../../course/trajectory-collector/README.md) — instructor deployment and credentials.
- [Session persistence](../../session/session-persistence/README.md) — original archive read handles.

<a id="model-experience"></a>
## Model Experience

None, as collection and inspection do not add model requests, prompts, tools, or Session events.

#### KV Cache effect

No request tokens or request prefixes change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Enrollment and automatic student uploads are not implemented; the identity provider and service hostname remain placeholders. Do not distribute an image claiming automatic remote collection.
- Collection is not attestation. A student controlling the VM or hypervisor can suppress or fabricate source data; events never persisted cannot be recovered.
- Whole binary objects are bounded buffers. Large-file streaming, binary remote export, and multiple independently acknowledged remote destinations are not provided.

<a id="dev-note"></a>
### Dev Note

None.
