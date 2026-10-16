# Agent Note: Assessment journal and RAGE exchange

Status: implemented

English | [中文](2026-10-15-assessment-journal-and-rage-exchange.zh.md)

## Problem

Repeated assessments need persistent business knowledge and work history. Collector failures, changed access contexts and analyst corrections make a graph of asserted current relationships insufficient for deciding whether earlier work applies.

## Decision

The [assessment memory plugin](../../../../packages/experimental/assessment-memory/README.md) owns an immutable business journal through Storage Domain. Current assets, structural relationships and operational records are replayed projections. Evidence, corrections and dispatch intents survive separately from current conclusions. A transaction validates a private projection, waits for durable storage and then publishes it.

RAGE is an attributed exchange boundary for the supported graph subset. Imported assertions remain untrusted and inferred. Custom structural edges do not claim executable attacker capabilities. Operator configuration owns the assessment and scope revision; graph updates cannot grant destination access.

Capability analysis uses explicit evidence-supported assertions rather than structural adjacency. Access context, AND prerequisites and conditions constrain traversal; each prerequisite source must be reached before it contributes control. Paths pin capability and business-objective revisions. A changed fact or revision invalidates dependent conclusions and generates retest work in the same journal transaction. Repeated identical observations do not close or duplicate that work. Validation requires a matching completed attempt; it remains an attributed claim rather than independent reviewer authentication.

## Alternatives considered

**Use RAGE as the complete operational database.** RAGE's identity and access graph does not own task claims, collector failures, finding retests or cleanup duties. Encoding all operational state as standard access edges would misrepresent its semantics; those records stay in the journal.

**Let the model decide when all discoveries need recording.** This can silently omit accepted structured results. The plugin observes final tool outcomes and automatically parses supported recon inventory; unsupported collectors remain explicitly unparsed and need deliberate submissions.

**Mutate one current record per asset.** This loses contradictory evidence and makes corrections erase history. Separate assertions cost memory and replay time but preserve the basis for later decisions.

## Consequences

The plugin can explain earlier observations and mark attempts whose access context, freshness or observed configuration no longer applies. Exclusive task claims coordinate sessions within one process. Storage and replay remain bounded by operator settings; automatic compaction and distributed coordination are absent. A crash after external execution can leave an unknown outcome, requiring Session evidence reconciliation before a repeat.

Loader/SQLite integration tests cover replay, revisions, claims, corrections, changed assumptions and automatic intake. A keyless recorded CLI session covers binding guidance and ordinary memory tools. This decision does not provide a RAGE derivation engine, a graph UI or automatic scheduling.

Native provider/realm/type/id tuples stabilize identity across display-name changes. Capability expiry is evaluated against query time; retest tasks are materialized on the next journal operation so replay never depends on wall-clock time. Candidate searches charge prerequisite evaluation to their explicit budget and report incomplete explanations. Coverage plans retain test/context/configuration cells separately from tool receipts; collection success alone does not fill those cells.
