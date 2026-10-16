---
description: "Instructor-side Logfire export of stored course trajectories, private credentials, recovery, and student-enrollment release requirements."
---

# Course trajectory collector

English | [中文](README.zh.md)

## Summary

Collect an instructor-accessible DSH archive into a durable local database with authenticated read-only inspection, or export it directly to Logfire. Dedicated instructor compositions run outside the research environment; an optional overlay integrates collection into an existing trusted local Web app. Student ingestion routes reject uploads until a separate course authorization provider exists. Course SSO, enrollment, credential renewal, and automatic student transfer remain placeholders; the [deployment assumptions](../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.md) remain requirements.

## Table of Contents

- [Instructor deployment](#instructor-deployment)
- [Local collection and inspection](#local-collection-and-inspection)
- [Integrated local Web app](#integrated-local-web-app)
- [Observe and recover](#observe-and-recover)
- [Student-image release requirement](#student-image-release-requirement)
- [Verification](#verification)

<a id="instructor-deployment"></a>
## Instructor deployment

Run only on the instructor's host, with an archive approved for full-content export. Supply an existing session root, a unique source namespace, and a private file containing only the Logfire write token. Never place that file in this repository, an image build context, a student image, or the research workspace. Collector UID 1000 must be able to read the archive and token; Compose file secrets may retain host permissions. The archive is mounted read-only, checkpoint storage is private, and no listening port is exposed.

Set these non-secret values and the token's path, not its value, from the repository root:

```sh
export COURSE_SESSION_ROOT=/srv/course/incoming/installation-001/sessions
export COURSE_TRAJECTORY_SOURCE_ID=cohort-a-installation-001
export COURSE_OTLP_LOGS_ENDPOINT=https://logfire-us.pydantic.dev/v1/logs
export LOGFIRE_TOKEN_FILE=/srv/course/secrets/logfire-write-token
export COURSE_BUILD_COMMIT=$(git rev-parse --short=12 HEAD)
docker compose -f course/trajectory-collector/compose.yml config --quiet
docker compose -f course/trajectory-collector/compose.yml build
docker compose -f course/trajectory-collector/compose.yml run --rm collector --dump-config
docker compose -f course/trajectory-collector/compose.yml up -d --wait
```

Use `logfire-eu.pydantic.dev` for an EU project per the [Logfire collector configuration](https://pydantic.dev/docs/logfire/migrate/overview/). Compression defaults to `zstd`, matching the base harness profile; set `COURSE_SESSION_COMPRESSION=none` for uncompressed archives before launch. Do not create an empty source directory and assume student data is arriving: this deployment does not transfer files from student VMs. Use one private state volume per source namespace and destination; do not combine archives with colliding session IDs.

The Dockerfile builds the harness runtime and launches only `dsh --profile course-trajectories`. Its profile mounts console logging, the JSONL provider, and [trajectory-export-otlp](../../packages/experimental/trajectory-export-otlp/README.md), with no model adapter, tools, browser, or feedback exporter. Do not mount a student's whole home, Docker socket, or research credentials. Keep this collector outside the research network namespace; do not add Logfire to target scope.

<a id="local-collection-and-inspection"></a>
## Local collection and inspection

The separate [local profile](profile-local/cordis.patch.yml) mounts SQLite storage, a read-only archive consumer, and HTTP inspection with the harness's existing instructor browser authentication. It has no model or tools. Its listener binds only `127.0.0.1:4319`; the startup log supplies a fresh local login URL. An authenticated instructor can inspect `/trajectory`, query `/api/trajectory/records` and `/api/trajectory/status`, and download binaries through the bounded artifact API. The dashboard is a read-only JSON page, not a trace-span waterfall. Do not expose the local HTTP listener on a public network.

The [local Compose file](compose.local.yml) targets a dedicated Linux instructor host with host networking. Set the same existing archive and build metadata variables, plus instructor-assigned `COURSE_INSTALLATION_ID`, `COURSE_STUDENT_ID`, and `COURSE_COHORT_ID`. These are local archive labels, not verified SSO claims. The named intake volume preserves committed records, replay protection, revocations, and the remote acknowledgement cursor. The temporary browser credential store resets on container recreation. The healthcheck verifies the authenticated listener, not collection completeness; inspect worker errors and durable counters too. Image build and deployment acceptance belong to the course host operator.

The local composition sends nothing remotely by default and needs no Logfire token. The [Logfire overlay](compose.local-logfire.yml), applied with the local Compose file, explicitly enables full collector logs and completed OTLP traces and mounts the instructor's token file. Supply the existing logs endpoint, source namespace, token path, and local labels above, plus the same project's HTTPS `/v1/traces` endpoint:

```sh
export COURSE_OTLP_TRACES_ENDPOINT=https://logfire-us.pydantic.dev/v1/traces
docker compose -f course/trajectory-collector/compose.local.yml -f course/trajectory-collector/compose.local-logfire.yml config --quiet
```

The overlay requires both endpoint variables. The profile mounts a private [projection](../../packages/experimental/trajectory-projection/README.md) only when the traces endpoint is present. Full logs keep their `/var/lib/trajectory/export` checkpoints; the optional `/traces` consumer uses `/var/lib/trajectory/export-traces` and never acknowledges the log cursor. The projection database lives separately under `/var/lib/trajectory/projection`. Do not share, erase, or exchange these states. The remote overlay healthcheck requires the authenticated local listener and fresh healthy status from both exporters; it does not attest collection completeness. The [exporter](../../packages/experimental/trajectory-export-otlp/README.md#add-completed-traces) owns nesting, selected metadata, acknowledgement, replay, and failure semantics.

Local binary archival requires explicit `copyAttachments` consent plus the matching attachment provider and read-only object archive; it is not enabled by this profile and does not send binary bytes to Logfire. Follow the [archive consumer reference](../../packages/experimental/trajectory-collector-archive/README.md) for those limits. This overlay does not add student enrollment, an uploader, or a production SSO authorizer.

Student POST routes return unavailable without `TrajectoryUploadAuth`; instructor cookies cannot authorize ingestion. Do not configure a shared image token to bypass this. The [HTTP plugin](../../packages/experimental/trajectory-collector-http/README.md) defines bounded routes, identity separation, revocation, and ambiguous timeout/replay behavior. The [storage provider](../../packages/experimental/trajectory-collector-sqlite/README.md) owns quota and retention guarantees; never delete its deduplication metadata to make space.

<a id="integrated-local-web-app"></a>
## Integrated local Web app

After building current artifacts, use the [preflight launcher](native.mjs) with the existing supported Web profile:

```sh
node course/trajectory-collector/native.mjs --profile web
```

The launcher validates required local labels and archive placement before starting the ordinary built CLI with the [overlay](native.overlay.yml). It preserves inherited settings and forwarded CLI arguments, forwards shutdown signals, and waits for its child to exit. The overlay inserts local SQLite collection, the read-only archive consumer, trace projection, the Trajectories viewer, and HTTP inspection. It reuses the app's persistence provider, current session root, and same-origin instructor authentication; it does not replace research configuration or start another listener. Coordinate a restart with the current app owner instead of starting a second process on its port.

This overlay reads the mounted app's archive. When [Course Runtime](../../packages/experimental/course-runtime/README.md) is also enabled, applying Protected mounts the same viewer client there, and the native controller pulls bounded authenticated pages of its persisted session records into this collector. Protected uses a separate installation identity, so identical session IDs cannot collide with Local. This copies record content, not attachment binaries, and does not enable remote export. The research container receives no collector database, Docker socket, native cookie, or archive write credential.

Set these inherited deployment values before launch; none is an API secret:

| Variable | Meaning |
|---|---|
| `DSH_HOME` | Explicit absolute path of the existing app's home and profile settings |
| `COURSE_COLLECTOR_DB` | Absolute collector SQLite path in a dedicated owner-only directory outside the research-writable home |
| `COURSE_PROJECTION_DB` | Absolute projection SQLite path in a separate owner-only directory |
| `COURSE_INSTALLATION_ID` | Instructor-assigned local installation label |
| `COURSE_STUDENT_ID` | Instructor-assigned local student label, not an authenticated claim |
| `COURSE_COHORT_ID` | Instructor-assigned local cohort label |

Keep the existing `DSH_HOME`, profile settings, and loopback listener. The launcher rejects missing labels, relative paths, archives inside `DSH_HOME`, and a shared collector/projection directory; storage providers also enforce owner-only real files and directories. Bypassing it with the raw overlay bypasses this preflight: the general Loader can leave a failed plugin inactive while other app services continue. Check archive and projection progress, not merely listener availability.

Full records remain in the collector while the projection supplies derived trace views; the package references own projection and viewer limits. This overlay mounts no student upload authorizer or remote exporter, and leaves binary copying disabled. Local labels do not establish SSO identity. Integration inside a trusted local app is not process isolation from that app; use a dedicated instructor deployment when the research process is untrusted.

<a id="observe-and-recover"></a>
## Observe and recover

Inspect collector logs and acknowledgement status:

```sh
docker compose -f course/trajectory-collector/compose.yml logs --tail 100 collector
docker compose -f course/trajectory-collector/compose.yml exec collector node --eval "process.stdout.write(require('fs').readFileSync('/var/lib/trajectory/health.json'))"
```

The [exporter reference](../../packages/experimental/trajectory-export-otlp/README.md#delivery-and-recovery) owns delivery guarantees, retries, checkpoints, fragmentation, and failures. In Logfire, filter by `dsh.source.id` and `dsh.session.id`, then order logs by `dsh.event.seq`. Retain all fragments and deduplicate record/part identities for reconstruction. The standalone archive deployment exports complete OTLP logs only; the local Logfire overlay also exports real completed trace spans. Traces are selected recorded metadata, not a replacement for source logs or uploaded screenshot/file blobs. Vendor project limits and retention still apply.

For the local Logfire overlay, inspect both `/var/lib/trajectory/export/health.json` and `/var/lib/trajectory/export-traces/health.json`. A healthy logs exporter does not acknowledge trace delivery or vice versa. Inspect archive and projection progress as well; an idle receiver cannot prove every source record was collected.

The healthcheck marks failed, stopped, stale, or retrying export unhealthy. Retain the source and checkpoint volume; repair credentials/network/storage and restart after terminal failures. The plugin rereads the token path on every request, but replacing a Compose bind-mounted secret inode can require recreating its container. Do not erase checkpoints to fix a destination mismatch: review replay and duplication first. Ordinary Compose shutdown preserves the named state volume; do not use `down -v`.

After a crash or forced kill, container PID reuse can leave a stale owner lock that prevents restart. Stop every collector using this state volume, confirm no previous owner remains, and remove only `/var/lib/trajectory/owner.lock` through an instructor maintenance container. Preserve destination metadata and event checkpoints. Concurrent containers must not share this state volume; see the exporter's lock limitations.

The local Logfire overlay instead keeps separate exporter locks at `/var/lib/trajectory/export/owner.lock` and `/var/lib/trajectory/export-traces/owner.lock`. Apply the same stopped-owner checks before removing either stale lock. Keep the collector and projection databases intact.

<a id="student-image-release-requirement"></a>
## Student-image release requirement

The requirement is one-time course SSO enrollment, installation-specific credentials with automatic short-lived renewal and revocation, and server-assigned student/cohort identity. Students do not create or paste an API secret; only the instructor service holds the Logfire project token. The broker, provider/service hostname, image connection UI, and installation credential provider remain placeholders. Durable ingestion and its authorization interface exist, but no production student verifier or uploader is mounted. Do not distribute an image claiming automatic remote copies until the [enrollment acceptance criteria](../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.md#acceptance-criteria) pass.

<a id="verification"></a>
## Verification

Keyless [Loader tests](../../packages/experimental/trajectory-export-otlp/tests/export.spec.ts) use the real persistence provider and an independent protobuf-decoding loopback receiver. They replay the recorded scope trajectory and compare complete remote events to the source, without a vendor token. No real Logfire project is contacted. Verify the dedicated Linux image and a live Logfire acceptance run on the course host before deployment; Compose validation and native builds cannot establish those results.

The [built remote-profile test](../../packages/experimental/trajectory-export-otlp/tests/built-remote-profile.e2e.ts) launches the exact local profile in a private home, enables both exporters only against allocated loopback receivers, compares full log events, decodes real trace protobuf, and verifies separate checkpoints and drained shutdown. The matching local-only test clears both endpoint variables and verifies that no remote export occurs. Neither test activates an existing app or contacts Logfire.

After building current CLI and plugin artifacts, run `node --test course/trajectory-collector/tests/native-profile.test.mjs`. This isolated built-profile check uses a private source log and allocated loopback port; it verifies preflight rejection, authenticated collector/viewer routes, committed trace/span views, exact source bytes, deduplicated replay and stable projection identity across restart, and graceful process disposal. It does not activate an existing app, exercise the browser UI, contact a model, or upload to Logfire.
