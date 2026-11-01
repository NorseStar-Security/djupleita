# Course audit stream

Pedram Amini's Cloudflare audit receiver and instructor board, preserved from `NorseStar-Security/djupleita` at `c38d1112d02d4c695873dd05b32fd9238bdb2a75` (the full source revision is recorded in `UPSTREAM.md`). This includes the newer course-wide writer tokens, seat listing, fifty recent Sessions per seat, and authenticated operator publishing route. Djupleita adds a compatible sender in the optional Telemetry export plugin.

## Configure Djupleita

The default telemetry configuration sends nothing. In **Plugins → Telemetry export**, configure the receiver endpoint and an existing host-bound credential identity. Use a seat token for one installation, or a course token restricted to a cohort and installation prefix. Add only the approved receiver host to `scope.services.telemetry`.

```json
{
  "telemetry": {
    "enabled": true,
    "endpoint": "https://ns-audit.example.workers.dev/v1/logs",
    "identityId": "<UUID of the receiver-bound bearer identity>",
    "courseAudit": { "sourceId": "sans-seat-01", "fragmentBytes": 32768 },
    "maxQueued": 10000,
    "maxAttempts": 12
  }
}
```

`sourceId` must equal a seat token's installation, or begin with a course token's installation prefix. The receiver derives cohort/student identity from the verified token. Keep token values in the credential/identity store, outside committed configuration. The example identity ID is a placeholder to replace through the UI.

This mode sends the full redacted Djupleita trajectory, including subagent records, tool actions, policy decisions, and reasoning returned by the selected model. It does not manufacture reasoning for models that do not return it. Provider credentials are redacted before hashing, queuing and export. The board unwraps recorded Harness events for its reasoning and tool summaries. Exact redacted records remain available through the receiver's raw-record route.

Each engagement/chat pair has a separate remote Session ID. A synthetic header precedes sequence zero. Large records are split into independently acknowledged OTLP/HTTP JSON requests; the receiver verifies the reconstructed SHA-256 digest before committing the record. The durable local outbox sends fragments and records in sequence, stops at a failed request, and resumes after backoff or app restart. Replays are deduplicated by record/part identity. An exhausted request stays queued and stops later course records until the operator repairs the failure. Changing endpoint or course source creates a separate outbox/cursor namespace. Keep the original outbox when repairing configuration.

The existing generic OTLP/Logfire export mode remains available when `courseAudit` is absent. Generic OTLP payloads do not carry the receiver's custody attributes; enable course mode when using this receiver.

## Deploy the receiver

From `worker/`, with your approved Cloudflare account selected:

```sh
npm ci --ignore-scripts
npx wrangler r2 bucket create ns-audit-raw
npx wrangler r2 bucket create ns-teacher-console
node scripts/token.ts key > /instructor/secrets/token-key
tr -d '\n' < /instructor/secrets/token-key | npx wrangler secret put AUDIT_TOKEN_KEY
npx wrangler deploy
npx wrangler r2 bucket lock add ns-audit-raw raw-30d raw/ --retention-days 30
```

Choose the retention period according to course policy before applying a bucket lock. The optional `PUBLISH` R2 binding supports operator publishing; provision its bucket before using that route. No Cloudflare account IDs or deployed credentials ship in the configuration. Deployment is an instructor action; it is not part of Djupleita startup.

Issue tokens with the preserved CLI:

```sh
node scripts/token.ts seat --key-file /instructor/secrets/token-key --cohort pilot --student seat-01 --installation webtop-01 --days 30
node scripts/token.ts course --key-file /instructor/secrets/token-key --cohort sec590 --prefix sans- --days 30
node scripts/token.ts board --key-file /instructor/secrets/token-key --cohort pilot --days 7
node scripts/token.ts admin --key-file /instructor/secrets/token-key --days 1
```

Keep the signing key and board/admin credentials on an instructor host. A shared course token may write multiple installations under its configured prefix; prefer per-seat tokens when you require individual upload identity. Label syntax and token validation are defined in `worker/src/token.ts` and `worker/src/writer.ts`.

## Watch and inspect

Open `https://<receiver>/board?cohort=<cohort>#token=<board token>`. The board shows activity and reasoning previews, with read access controlled by seat or board tokens. Treat the URL and WebSocket credential as sensitive; do not share them in screenshots or logs.

| Route | Capability |
|---|---|
| `POST /v1/logs` | Seat/course-authenticated JSON or protobuf ingestion; digest verification and duplicate suppression |
| `GET /api/cohort?cohort=C` | Live cohort activity |
| `GET /api/seats?cohort=C` | Every stored seat in the authorized cohort |
| `GET /api/seat?installation=I` | Seat identity, Session totals, receipt chains and recorded problems |
| `GET /api/records?installation=I&session=S&after=N&limit=L` | Indexed records in sequence order |
| `GET /api/raw?installation=I&session=S&seq=N` | Exact stored record bytes |
| `POST /api/revoke?installation=I&reason=R` | Admin-authenticated seat revocation |
| `PUT /api/publish?key=K` | Admin-authenticated console JSON or evidence PNG publishing to the optional `PUBLISH` bucket |

Seat tokens read only their own seat. Board tokens read their authorized cohort; an explicitly global board token can read all cohorts. Course tokens upload but cannot read instructor data. The immutable R2 ledger and receipt chain record what the receiver accepted; they do not attest execution or prevent modification before collection.

## Verify locally

```sh
# At the project root, after ordinary build/setup:
pnpm exec vitest run tests/export.test.ts tests/course-audit.test.ts

cd course/audit-stream/worker
npm ci --ignore-scripts
npm test
npm run typecheck
```

The integration test sends fragmented Djupleita reasoning through the actual JSON decoder, writer authorization and SQLite ledger, simulates an export failure/restart, verifies record bytes and receipt ordering, checks duplicate replay, and rejects source impersonation and digest tampering. Worker tests also retain the original exporter-produced protobuf fixtures. No model, target, or hosted collector is contacted by these tests. A deployed Cloudflare smoke run remains separate acceptance work.

## Isolation and retention

The shipped sender runs in the app process and exports redacted copies. It is an equivalent course streaming path, not the older instructor-isolated collector deployment. It cannot protect its upload token or suppress tampering by code with access to the app process or local storage. Deploy an instructor-owned collector with a read-only archive mount when that separation is required. Automatic SSO enrollment is not implemented. Remote export remains opt-in, and R2 bucket locks and provider retention may prevent removal after upload.
