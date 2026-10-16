---
description: "Stream every lab-client Session record, including model reasoning, to a Cloudflare receiver that verifies, stores, and broadcasts it."
---

# Course audit stream

English | [中文](README.zh.md)

## Summary

Give instructors a live, verifiable copy of what each lab-client agent reasons and does. Each seat runs the unchanged [trajectory exporter](../../packages/experimental/trajectory-export-otlp/README.md) outside the research process. A Cloudflare Worker authenticates the seat, checks every record digest, stores the exact bytes in R2, chains receipts per Session, and pushes a summary to a live board. The [lab-client patch](lab-client.patch.yml) turns on model reasoning, so the Session log has reasoning to export.

## Table of Contents

- [Components](#components)
- [Turn on reasoning](#turn-on-reasoning)
- [Deploy the receiver](#deploy-the-receiver)
- [Issue tokens](#issue-tokens)
- [Stream a seat](#stream-a-seat)
- [Watch and inspect](#watch-and-inspect)
- [Receiver behavior](#receiver-behavior)
- [Verification](#verification)
- [Known limitations](#known-limitations)

<a id="components"></a>
## Components

| Path | Role |
|---|---|
| [lab-client.patch.yml](lab-client.patch.yml) | Web-profile patch: the course gateway route with declared reasoning levels, and the default model |
| [worker/src/](worker/src/index.ts) | The receiver: `index.ts` routes, `ledger.ts` per-seat commits, `room.ts` live board fan-out, `otlp.ts` OTLP decoding, `token.ts` tokens |
| [worker/scripts/token.ts](worker/scripts/token.ts) | Mints the signing key and seat, board, and admin tokens |
| [worker/scripts/smoke.ts](worker/scripts/smoke.ts) | Replays exporter fixtures against a deployed receiver |
| [worker/tests/](worker/tests/ledger.test.ts) | Node test runner suites and exporter-encoded fixtures |

<a id="turn-on-reasoning"></a>
## Turn on reasoning

The course gateway returns reasoning only when a request carries `reasoning_effort`. `llm-pi-ai` sends that field only for models that declare reasoning levels, and a hand-declared model declares none, so a seat configured through the Models page records no reasoning. Seed [lab-client.patch.yml](lab-client.patch.yml) as `$DSH_HOME/profiles/web/cordis.patch.yml`, set `SEC590_LLM_BASE_URL` in the service environment or write the gateway URL into the seeded copy, and store the gateway key as the `SEC590_LLM_API_KEY` reference in `$DSH_HOME/.credentials.yaml`:

```yaml
refs:
  SEC590_LLM_API_KEY: '<gateway key>'
```

The headless bundle disables the managed credential store, so headless runs read `SEC590_LLM_API_KEY` from the environment. Check the composition with `dsh --profile web --dump-config`, then confirm `reasoning` blocks inside `assistant/message` content in a new Session. Reasoning tokens count toward the output cap and add latency.

<a id="deploy-the-receiver"></a>
## Deploy the receiver

Run these from `worker/` with a logged-in `wrangler`. The configuration names its bindings and holds no account or resource ids.

```sh
npm install
npx wrangler r2 bucket create ns-audit-raw
node scripts/token.ts key > /instructor/secrets/token-key
tr -d '\n' < /instructor/secrets/token-key | npx wrangler secret put AUDIT_TOKEN_KEY
npx wrangler deploy
npx wrangler r2 bucket lock add ns-audit-raw raw-30d raw/ --retention-days 30
```

Keep the signing key on an instructor host. The bucket lock stops deletion and overwrite of stored records for its retention period; choose the period the course retention policy approves.

<a id="issue-tokens"></a>
## Issue tokens

Mint one seat token per installation. Its installation label must equal the exporter `sourceId`.

```sh
node scripts/token.ts seat --key-file /instructor/secrets/token-key --cohort pilot --student seat-01 --installation webtop-01 --days 30
node scripts/token.ts board --key-file /instructor/secrets/token-key --cohort pilot --days 7
node scripts/token.ts admin --key-file /instructor/secrets/token-key --days 1
```

Seat tokens upload records and read their own seat. Board tokens read one cohort, or every cohort with `--cohort '*'`. Admin tokens revoke seats. Labels are 1 to 64 characters of `[A-Za-z0-9._-]`. Store each seat token where only its exporter can read it, never in the seat's home or any research-writable path.

<a id="stream-a-seat"></a>
## Stream a seat

Run one [trajectory collector](../trajectory-collector/README.md) per seat from an instructor-owned checkout, with the seat's Session root mounted read-only. The collector's endpoint and token variables accept any OTLP logs receiver:

```sh
export COURSE_SESSION_ROOT=/srv/seats/webtop-01/config/.dsh/sessions
export COURSE_TRAJECTORY_SOURCE_ID=webtop-01
export COURSE_OTLP_LOGS_ENDPOINT=https://ns-audit.example.workers.dev/v1/logs
export LOGFIRE_TOKEN_FILE=/instructor/secrets/webtop-01.token
export COURSE_BUILD_COMMIT=$(git rev-parse --short=12 HEAD)
docker compose -p audit-webtop-01 -f course/trajectory-collector/compose.yml up -d --build --wait
```

The JSONL backend writes each append batch as one fsynced, checksummed frame, and readers drop a torn final frame, so the collector follows live Sessions while the seat writes them. It scans every second by default and delivers records in order per Session. Keep the token file and checkpoint volume outside the seat container: code that can read the token can upload as that seat, and code that can reach the collector can stop it.

<a id="watch-and-inspect"></a>
## Watch and inspect

Open `https://<receiver host>/board?cohort=<cohort>#token=<board token>`. Browsers do not send the fragment to the server; the page connects to `/ws` and shows per-Session totals (records, reasoning characters, tool calls, tool errors, scope denials) and a live feed with reasoning previews. A seat token opens the same page restricted to its own seat.

| Route | Token | Returns |
|---|---|---|
| `GET /api/cohort?cohort=C` | board | Seats and recent activity for the cohort |
| `GET /api/seat?installation=I` | board for the seat's cohort, or that seat | Seat identity, Session totals with chain heads, and recorded problems |
| `GET /api/records?installation=I&session=S&after=N&limit=L` | board for the seat's cohort, or that seat | Indexed records in sequence order |
| `GET /api/raw?installation=I&session=S&seq=N` | board for the seat's cohort, or that seat | Exact bytes of the record at that sequence |
| `POST /api/revoke?installation=I&reason=R` | admin | Revokes the seat; later uploads fail with 403 |

<a id="receiver-behavior"></a>
## Receiver behavior

- **Authentication first.** `POST /v1/logs` requires a seat token, and identity comes only from the token. A record whose `dsh.source.id` differs from the token installation is refused with 403. A seat stays bound to the cohort and student of its first upload; a different pair is refused with 409.
- **Verification before storage.** A single-part record must hash to `dsh.record.sha256`. Fragments are stored as decoded bytes, and the final fragment is accepted only when the reassembled record matches; otherwise the request is refused with 422.
- **Commit before acknowledgement.** The seat's Durable Object writes each part to R2 and indexes it in its SQLite store before the response. Storage and Durable Object failures answer 503 with `Retry-After`, which the exporter retries. Replays are acknowledged as duplicates by record id and part.
- **Receipt chain.** Each complete record extends its Session chain with `sha256(previous, seq, record digest)`, starting from a digest of the installation and Session id. A sequence other than the next expected one is recorded as `SEQUENCE_GAP` or `SEQUENCE_REPEAT`.
- **Immutable objects.** Keys follow `raw/<cohort>/<student>/<installation>/<session>/<position>-p<part>of<parts>-<record id prefix>`. The ledger never overwrites a key, so the bucket lock holds every stored part.
- **Live fan-out.** After a commit, the receiver passes one summary per complete record to the cohort's Durable Object, which keeps the latest 300 and pushes them to connected boards. Board delivery is best effort; R2 objects and seat indexes remain authoritative.

Status codes: 200 accepted with an empty `application/x-protobuf` body; 400 malformed OTLP or attributes; 401 missing or invalid token; 403 wrong token kind, source mismatch, or revoked seat; 409 identity conflict; 413 a body over `MAX_REQUEST_BYTES`; 415 an unsupported media type or content encoding; 422 a digest or UTF-8 failure; 503 a retryable storage failure.

<a id="verification"></a>
## Verification

```sh
cd course/audit-stream/worker
npm test
npm run typecheck
NS_AUDIT_URL=https://ns-audit.example.workers.dev NS_AUDIT_SEAT_TOKEN=<seat token for seat-fixture> NS_AUDIT_BOARD_TOKEN=<board token> node scripts/smoke.ts
```

The tests cover OTLP decoding, tokens, ledger commits over `node:sqlite`, and board summaries. Their fixtures come from the shipped exporter encoder and recorded Sessions; regenerate them from the repository root with `node --import tsx/esm course/audit-stream/worker/tests/fixtures/generate.ts` after `pnpm install`. Point `scripts/smoke.ts` at a dedicated smoke cohort, because stored records cannot be removed during the lock period.

<a id="known-limitations"></a>
## Known limitations

- Seats are identified by tokens issued at provisioning. Laptop enrollment through course SSO remains the [enrollment proposal](../../.agents/notes/proposed/architecture/2026-10-15-course-telemetry-enrollment.md).
- Code with write access to a seat's Session files can alter records before the collector reads them. The chain records what the receiver committed and in which order; it does not attest execution.
- The receiver accepts Session records only. Gateway network logs, action-review receipts, and range-ledger submissions need their own senders.
- No per-seat rate limit applies beyond `MAX_REQUEST_BYTES` and Cloudflare platform limits.
- Board summaries cover the record types the course uses; other types show their type name.
