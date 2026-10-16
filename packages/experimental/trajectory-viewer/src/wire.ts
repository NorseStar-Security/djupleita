/** Validate HTTP inspection data before publishing it to browser resources. */
import type { CollectorPage, CollectorStatus } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type { ProjectionStatus, TraceDetailPage, TraceListPage } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'

/** Collector counters and the independent projection high-water mark. */
export interface HealthPage { collector: CollectorStatus; projection: ProjectionStatus }
/** One bounded resource page. */
export type ViewerValue =
  | { kind: 'status'; page: HealthPage }
  | { kind: 'traces'; page: TraceListPage }
  | { kind: 'detail'; page: TraceDetailPage }
  | { kind: 'records'; page: CollectorPage }

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('VIEWER_INVALID_RESPONSE')
  return value as Record<string, unknown>
}
function fields(value: unknown, strings: string[], numbers: string[]): Record<string, unknown> {
  const row = object(value)
  if (strings.some(key => typeof row[key] !== 'string') || numbers.some(key => typeof row[key] !== 'number' || !Number.isSafeInteger(row[key]) || row[key] < 0)) throw new Error('VIEWER_INVALID_RESPONSE')
  return row
}
function identity(value: unknown): void { fields(value, ['installationId', 'studentId', 'cohortId'], []) }
function trace(value: unknown): void {
  const row = fields(value, ['traceId', 'rootSpanId', 'sessionId', 'name', 'status'], ['cursor', 'startTime', 'firstCursor', 'lastCursor'])
  if (!/^[a-f0-9]{32}$/.test(row.traceId as string) || !/^[a-f0-9]{16}$/.test(row.rootSpanId as string)
    || !['running', 'completed', 'blocked', 'error', 'incomplete'].includes(row.status as string)
    || (row.endTime !== null && (typeof row.endTime !== 'number' || !Number.isFinite(row.endTime)))
    || (row.turn !== null && (typeof row.turn !== 'number' || !Number.isSafeInteger(row.turn)))
    || (row.parentSessionId !== null && typeof row.parentSessionId !== 'string')
    || (row.parentTraceId !== null && typeof row.parentTraceId !== 'string')) throw new Error('VIEWER_INVALID_RESPONSE')
  identity(row.identity)
}
function page(value: unknown, key: string): { row: Record<string, unknown>; items: unknown[] } {
  const row = fields(value, [], ['nextCursor'])
  const items = row[key]
  if (!Array.isArray(items) || items.length > 100 || typeof row.hasMore !== 'boolean') throw new Error('VIEWER_INVALID_RESPONSE')
  return { row, items }
}

/**
 * Admit a fully buffered bounded response only after checking every field used in rendering.
 * @param kind - owned endpoint name.
 * @param value - untrusted JSON response.
 * @returns typed immutable page for the resource provider.
 * @throws if the response does not match the endpoint.
 */
export function parsePage(kind: string, value: unknown): ViewerValue {
  if (kind === 'status') {
    const root = object(value)
    fields(root.collector, [], ['records', 'artifacts', 'contentBytes', 'lastCursor', 'exportedCursor', 'revokedInstallations'])
    const projection = fields(root.projection, ['state', 'projectionId'], ['collectorCursor', 'sourceCursor', 'traces', 'spans', 'completedCursor'])
    if (!['indexing', 'idle', 'failed', 'stopped'].includes(projection.state as string)) throw new Error('VIEWER_INVALID_RESPONSE')
    if (projection.errorCode !== undefined && !['PROJECTION_INPUT', 'PROJECTION_SOURCE', 'PROJECTION_STORAGE', 'PROJECTION_QUOTA', 'PROJECTION_UNAVAILABLE'].includes(projection.errorCode as string)) throw new Error('VIEWER_INVALID_RESPONSE')
    return { kind, page: value as HealthPage }
  }
  if (kind === 'traces') {
    const result = page(value, 'traces')
    for (const item of result.items) trace(item)
    return { kind, page: value as TraceListPage }
  }
  if (kind === 'detail') {
    const result = page(value, 'spans')
    if (result.row.trace !== undefined) trace(result.row.trace)
    for (const item of result.items) {
      const span = fields(item, ['traceId', 'spanId', 'sessionId', 'name', 'kind', 'status', 'firstRecordId', 'lastRecordId'], ['cursor', 'startTime', 'firstCursor', 'lastCursor'])
      if (!/^[a-f0-9]{32}$/.test(span.traceId as string) || !/^[a-f0-9]{16}$/.test(span.spanId as string)
        || !['turn', 'model', 'tool', 'scope', 'event'].includes(span.kind as string)
        || !['running', 'completed', 'blocked', 'error', 'incomplete'].includes(span.status as string)
        || (span.endTime !== null && (typeof span.endTime !== 'number' || !Number.isFinite(span.endTime)))
        || (span.parentSpanId !== null && typeof span.parentSpanId !== 'string')) throw new Error('VIEWER_INVALID_RESPONSE')
      identity(span.identity); object(span.attributes)
    }
    return { kind, page: value as TraceDetailPage }
  }
  if (kind === 'records') {
    const result = page(value, 'records')
    for (const item of result.items) {
      const record = fields(item, ['id', 'sessionId', 'type', 'content', 'sha256'], ['cursor', 'timestamp', 'receivedAt'])
      if (typeof record.sequence !== 'number' || !Number.isSafeInteger(record.sequence) || record.sequence < -1) throw new Error('VIEWER_INVALID_RESPONSE')
      identity(record.identity)
    }
    return { kind, page: value as CollectorPage }
  }
  throw new Error('VIEWER_INVALID_ADDRESS')
}
