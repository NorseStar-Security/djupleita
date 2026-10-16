---
description: "Bounded trajectory uploads and authenticated, read-only instructor inspection over HTTP."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-trajectory-collector-http

English | [中文](README.zh.md)

## Summary

Inspect complete course trajectories in a local browser or a bounded JSON page. Download binary evidence as attachments without rendering uploaded content. Accept student uploads only when a separate course authorization provider supplies trusted identity. Requests have explicit byte, concurrency, and time limits; a successful upload response means storage confirmed the complete record.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin with durable storage and an HTTP listener. Instructor inspection uses the existing Harness browser authentication; student intake uses a different authorization service.

### Minimal configuration

This dedicated local composition enables inspection, not student ingestion. Set absolute paths in directories owned by the instructor. Keep the listener on loopback unless deployment authentication, TLS, and trusted authorities are configured separately.

```yaml
- name: '@deepseek-ai/dsh-host-webserver'
  config: { host: '127.0.0.1', port: 3081 }
- name: '@deepseek-ai/dsh-credentials-local'
  config: { path: '/var/lib/dsh-course/credentials.yaml', watch: false }
- name: '@deepseek-ai/dsh-client-connection'
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
  config: { path: '/var/lib/dsh-course/archive/collector.sqlite' }
- name: '@deepseek-ai/dsh-experimental-trajectory-collector-http'
  config: { serveRoot: true }
```

Open the instructor login URL printed once at activation. The existing root token exchange creates a browser cookie, removes the token from the URL, and redirects the authenticated root to `/trajectory`. Treat this local launch URL as a credential; it is not a student upload token. Leave `serveRoot: false` when an existing Harness Web application owns `/`, and authenticate through that application's login URL first. Missing instructor authentication returns `503`; missing or invalid browser authentication returns `401`, and untrusted Host or Origin returns `403`.

| Field | Default | Meaning |
|---|---|---|
| `path` | `/api/trajectory` | API prefix without a trailing slash. |
| `dashboardPath` | `/trajectory` | Read-only escaped HTML page. |
| `serveRoot` | `false` | Own `/` for the existing local instructor login. |
| `maxRecordBytes` | `1048576` | Complete record request budget. |
| `maxArtifactBytes` | `16777216` | Complete binary upload and download budget. |
| `maxConcurrent` | `16` | Active requests, including writes still settling. |
| `timeoutMs` | `30000` | Whole request deadline in milliseconds. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-trajectory-collector-http) lists all accepted limits.

### Upload and inspect

`POST /api/trajectory/records` accepts `application/json` containing exactly `sessionId`, `sequence`, `type`, `timestamp`, and complete JSON `content`. `POST /api/trajectory/artifacts` accepts `application/octet-stream`, a lowercase hexadecimal `X-Trajectory-Sha256`, and a percent-encoded display filename in `X-Trajectory-Name`. Additional identity fields or `X-Trajectory-*` headers are rejected. Both routes pass the Authorization header to `trajectoryUploadAuth`; only its result supplies installation, student, and cohort identity. Revoked installations cannot upload.

Authenticated instructors can read `GET /api/trajectory/records`, `/api/trajectory/status`, and `/trajectory`. Record pages accept `after`, `limit`, `maxBytes`, and exact `installationId`, `studentId`, `cohortId`, or `sessionId` filters. Use `nextCursor` for the next page. Unknown or repeated parameters fail rather than widening a query. `GET /api/trajectory/artifacts?installationId=…&id=…` downloads a complete binary attachment with no content sniffing. Responses disable caching; HTML escapes uploaded content and contains no scripts.

An ACK follows the storage promise, not receipt of the HTTP body. A timeout, disconnect, or storage failure leaves a started write's outcome unknown. Retry the exact payload: storage deduplication returns the original receipt, while conflicting content returns `409`. Over-budget input or output returns `413` without clipping; request a smaller page instead. Unload removes routes, cancels request/auth work, and waits for started storage operations to settle.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Maintainer details — click to expand</summary>

The [entry](src/index.ts) owns route registration and teardown. The [HTTP owner](src/http.ts) retains request capacity through durable settlement, even after a response deadline. The [wire parser](src/parsing.ts) validates untrusted bodies and exact selectors before storage receives them. Storage and both authentication services remain independently replaceable; this consumer neither enrolls installations nor grants research-target scope.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Collector definitions](../trajectory-collector/README.md) — identity and complete-record semantics.
- [SQLite storage](../trajectory-collector-sqlite/README.md) — durability, quotas, and revocation.
- [Host authentication](../../client/connection/README.md) — existing browser and request trust.
- [Course collector](../../../course/trajectory-collector/README.md) — deployment and enrollment requirements.

<a id="model-experience"></a>
## Model Experience

None, as HTTP intake and instructor inspection add no model requests, prompts, tools, or Session events.

#### KV Cache effect

No request tokens or request prefixes change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No production upload authorization provider, course SSO, enrollment, hostname, or automatic student uploader is included. Missing `trajectoryUploadAuth` returns `503` and never enables anonymous writes.
- Instructor access uses the existing local owner cookie, not course instructor roles. The root login is opt-in and cannot share `/` with another owner.
- Bodies, complete pages, and binary evidence use bounded buffers. Streaming and rich timeline visualization are not provided.
- Authorization providers must honor cancellation; storage operations must eventually settle. A non-cooperative dependency retains its request capacity and can delay unload.

<a id="dev-note"></a>
### Dev Note

None.
