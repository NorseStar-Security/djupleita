/** Bounded persisted trace views; original record bytes remain owned by the collector. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CollectorIdentity, InstallationId, StudentId, CohortId, TrajectoryRecordId } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'

/** Deterministic 32-lowercase-hex OTel trace identity scoped by installation, Session, and turn. */
export type TraceId = Branded<'TrajectoryTraceId'>
/** Deterministic 16-lowercase-hex OTel span identity within one trace. */
export type SpanId = Branded<'TrajectorySpanId'>
/** Generation identity of one projection database; consumers must reject checkpoint reuse after replacement. */
export type ProjectionId = Branded<'TrajectoryProjectionId'>
/** Turn health; blocked/error can be visible before the turn closes. */
export type TraceStatus = 'running' | 'completed' | 'error' | 'blocked' | 'incomplete'
/** Projection failures stop indexing without acknowledging the affected source record. */
export type ProjectionErrorCode = 'PROJECTION_INPUT' | 'PROJECTION_SOURCE' | 'PROJECTION_STORAGE' | 'PROJECTION_QUOTA' | 'PROJECTION_UNAVAILABLE'

/** A turn-level trace, or explicitly labeled Session activity outside any turn. */
export interface TraceSummary {
  traceId: TraceId
  rootSpanId: SpanId
  /** First collector record cursor; immutable keyset pagination identity. */
  cursor: number
  identity: CollectorIdentity
  sessionId: SessionId
  /** Session-local turn number, null only for activity outside a turn. */
  turn: number | null
  name: string
  startTime: number
  endTime: number | null
  status: TraceStatus
  parentSessionId: SessionId | null
  /** Only set when a parent-owned catalog event identifies the initiating trace. */
  parentTraceId: TraceId | null
  firstCursor: number
  lastCursor: number
}

/** Complete span metadata; times are epoch milliseconds, not wall-clock duration measurements. */
export interface TraceSpan {
  traceId: TraceId
  spanId: SpanId
  parentSpanId: SpanId | null
  /** Creation ordinal within this projection, used by detail pages. */
  cursor: number
  /** Immutable completion ordinal, null while a span remains open. */
  completionCursor: number | null
  identity: CollectorIdentity
  sessionId: SessionId
  turn: number | null
  parentSessionId: SessionId | null
  parentTraceId: TraceId | null
  kind: 'turn' | 'model' | 'tool' | 'scope' | 'event'
  name: string
  startTime: number
  endTime: number | null
  status: TraceStatus
  firstCursor: number
  lastCursor: number
  firstRecordId: TrajectoryRecordId
  lastRecordId: TrajectoryRecordId
  /** Selected recorded facts, not inferred tool/network attribution or clipped original content. */
  attributes: Record<string, JsonValue>
}

/** Exact identity/status filters plus bounded case-insensitive literal label search. */
export interface TraceFilters {
  installationId?: InstallationId
  studentId?: StudentId
  cohortId?: CohortId
  sessionId?: SessionId
  parentSessionId?: SessionId
  status?: TraceStatus
  search?: string
}
/** after=0 starts either direction; later pages use the returned exclusive cursor. */
export interface TraceListQuery { after: number; limit: number; direction: 'newest' | 'oldest'; filters?: TraceFilters }
/** Stable trace identity pages; mutable status/timing fields reflect the committed projection at read time. */
export interface TraceListPage { traces: TraceSummary[]; nextCursor: number; hasMore: boolean }
/** Detail span pagination is oldest-first and excludes ordinals at or below after. */
export interface TraceDetailQuery { traceId: TraceId; after: number; limit: number }
/** Missing traces are explicit; the complete span page is never silently clipped. */
export interface TraceDetailPage { trace: TraceSummary | undefined; spans: TraceSpan[]; nextCursor: number; hasMore: boolean }
/** Export readers consume only immutable completed spans, independently of collector log acknowledgements. */
export interface CompletedSpanQuery { after: number; limit: number; maxBytes: number }
/** Durable settlement metadata required before a span enters the export feed. */
export type CompletedTraceSpan = TraceSpan & { completionCursor: number; endTime: number }
/** nextCursor is an immutable completion ordinal; callers checkpoint only after remote acknowledgement. */
export interface CompletedSpanPage { projectionId: ProjectionId; spans: CompletedTraceSpan[]; nextCursor: number; hasMore: boolean }
/** Persistent progress and visible terminal indexing failure; reads retain the last committed view after failure. */
export interface ProjectionStatus {
  projectionId: ProjectionId
  state: 'indexing' | 'idle' | 'failed' | 'stopped'
  collectorCursor: number
  sourceCursor: number
  traces: number
  spans: number
  completedCursor: number
  errorCode?: ProjectionErrorCode
}
