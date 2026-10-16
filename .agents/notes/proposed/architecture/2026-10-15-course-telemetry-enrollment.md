# Agent Note: Course telemetry enrollment and remote trajectory custody

Status: proposed

English | [中文](2026-10-15-course-telemetry-enrollment.zh.md)

## Problem

Students receive the same Linux course image and need remote trajectory monitoring without configuring an API secret. A shared credential in that image is extractable, cannot identify individual students reliably, and cannot revoke one installation. Giving the research agent a Logfire project token also gives it an unnecessary route to the observability service.

## Proposal

Treat an instructor-operated enrollment and authenticated-ingest service as a required deployment assumption, not an available feature. Distribution with automatic remote monitoring is blocked until the acceptance criteria below pass. The [instructor collector](../../../../course/trajectory-collector/README.md) exports stored trajectories to Logfire independently; it does not implement student enrollment, upload, or identity verification.

Enrollment uses an explicit “Connect to course” action and an OAuth device authorization flow through the course identity provider. Students complete SSO in their host browser or on another device, never in the research browser. A public client identifier is configuration, not a secret. A newly booted installation generates its own key and enrollment identity; image creation must not clone an enrolled installation. The service checks course membership and derives student, cohort, and installation identities from the authenticated enrollment, never from event attributes.

The enrollment broker issues short-lived, audience-restricted, write-only ingestion credentials. A collector-side credential provider owns renewal and a narrowly scoped refresh credential; the research process cannot read either. Support per-installation revocation and course expiry. Select sender-constrained credentials (DPoP or mTLS) where the identity provider and deployment support them. OAuth device flow and native-app guidance are defined by [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html) and [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html); token protection follows [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html).

The receiving service authenticates first, enforces per-identity quotas, stamps trusted identities, and acknowledges only after committing the complete event to a local durable store. Stable source/session/event identities support replay deduplication. Its persistence provider then feeds the OTLP exporter; only the instructor environment holds the Logfire write token. Keep enrollment, credential storage, ingestion, persistence, and export behind independently replaceable Cordis plugins. Do not alter agent-loop or relax the [research network policy](../../implemented/architecture/2026-10-14-course-network-scope.md) to add arbitrary observability access.

### Delivery plan

1. Export instructor-accessible persisted trajectories to Logfire through the opt-in OTLP consumer, retaining local history and acknowledgement checkpoints.
2. Build the authenticated ingestion API and durable local collector, including identity stamping, quotas, deduplication, retention controls, and an inspection UI.
3. Add the course enrollment broker and collector-side authorization/credential plugins using existing harness authorization extension points where applicable.
4. Wire the image's connect/renew/disconnect experience and verify offline recovery, revocation, and fresh-clone enrollment before course release.

## Alternatives considered

**Embed one class-wide Logfire token.** Rejected because every image recipient can extract it, impersonate the cohort, and exhaust project ingestion; rotation interrupts everyone.

**Ask each student to configure a personal API token.** Rejected because this moves deployment administration onto students and does not meet the agreed connection experience.

**Treat a generated VM identifier as authentication.** Rejected because an identifier is neither course membership nor evidence that a telemetry sender is trusted. An identical offline image cannot securely authenticate itself without enrollment or external provisioning trust.

## Acceptance criteria

- A clean image contains no enrollment, refresh, ingestion, or Logfire secret; independent clones generate distinct enrollment keys and require explicit connection.
- An enrolled student can connect through course SSO without copying a secret. A non-member, expired device code, wrong audience, revoked installation, and expired cohort cannot upload.
- Renewal is automatic and tested across expiry and offline periods. Logout/revocation invalidates the installation without invalidating classmates. Sensitive credentials and device codes never enter trajectory content or diagnostic logs.
- The server rejects unauthenticated upload, ignores forged student/cohort claims, limits resource usage, and commits before acknowledging. Disk-full and unavailable-store failures do not acknowledge; restart/replay deduplicates accepted event identities.
- The image's research process cannot access collector credentials, Logfire credentials, collector configuration, or a general-purpose remote executor. Operational connectivity stays separate from target authorization.
- Complete persisted event content and scope audit records reach the remote project after recovery. Local retention and disk alarms protect unacknowledged history; retention, privacy notice, and access controls are approved for the course.

## Risks

A student with root or hypervisor control can inspect installation secrets, suppress events, or fabricate trajectories. Enrollment identifies a credential holder, not an attested execution. Stronger evidence requires instructor-hosted VMs or a separately reviewed attestation design. Full trajectories can contain secrets and personal data; use lab accounts and explicit collection consent. Remote copies cover durable events, not data lost before local persistence, unreferenced binary artifacts, or arbitrary activity outside the harness.
