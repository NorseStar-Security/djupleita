# Agent Note: Collected trajectory trace index

Status: implemented

English | [中文](2026-10-15-collected-trajectory-trace-index.zh.md)

## Problem

Course observers need to inspect long agent runs without loading complete transcripts into a browser, while keeping exact records available for audit and optionally querying a remote service. Directly rendering raw OTLP logs does not express execution hierarchy or duration. Reusing the collector's log acknowledgement for derived traces could discard one signal when only the other was delivered.

## Decision

The [projection plugin](../../../../packages/experimental/trajectory-projection/README.md) incrementally derives a separate private SQLite index from committed collector records. Deterministic trace/span identities, durable source watermarks, an archive anchor, and a projection generation distinguish retries from archive replacement. The [viewer](../../../../packages/experimental/trajectory-viewer/README.md) queries bounded pages and reads exact source records separately. It does not modify source sessions or the agent loop.

The [trace exporter](../../../../packages/experimental/trajectory-export-otlp/README.md) consumes immutable completed spans with its own checkpoint, lock and destination binding. Whole-request acknowledgement advances only this trace cursor; collector log acknowledgement remains independent. Child association uses recorded installation-scoped session evidence, not fabricated parent spans or cross-trace links. Timing describes recorded observations, not unobserved network dispatch.

## Alternatives considered

**Browser-only folding.** Rejected because each observer would replay large histories and lose its derived state on reload. Source records remain available without making every view load them all.

**Only raw OTLP logs.** Retained for complete remote evidence, but insufficient as the sole execution visualization because logs lack parent-span hierarchy and duration.

**Shared log/trace checkpoint.** Rejected because the signals have different delivery outcomes and trace completion order differs from source arrival order. Independent durable cursors allow replay without silently skipping another signal.

**Mandatory remote service.** Rejected because course operation must work locally without a shared student image credential. Instructor-provided remote export is opt-in; enrollment and student upload authorization remain separate, unimplemented integration work.

## Consequences

Local queries remain bounded and restartable at the cost of a second private database and indexing delay. Projection failure and lag are visible; missing history stops indexing instead of inventing continuity. Complete records are not clipped, so unusually large records can require explicit export rather than GUI inspection. Protection of the collector and index remains instructor-owned, and collecting a native persistence root does not automatically collect a separate Protected Docker volume.
