/** Convert immutable projected spans to OTLP without inventing trace identities or truncating attributes. */
import { ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { TraceSpan } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'
import { DeliveryError } from './transport.ts'

type ReadableSpan = Parameters<typeof ProtobufTraceSerializer.serializeRequest>[0][number]

function time(milliseconds: number): [number, number] {
  const seconds = Math.floor(milliseconds / 1000)
  return [seconds, Math.floor((milliseconds - seconds * 1000) * 1_000_000)]
}

/**
 * Encode one complete closed span using the maintained OpenTelemetry protobuf serializer.
 * @param span - Immutable projection row; open spans cannot be exported.
 * @param sourceId - Instructor namespace, separate from trusted installation identity.
 * @param maxBytes - Complete encoded request budget, including resource and attributes.
 * @returns One bounded OTLP trace request; excessive spans fail without truncation.
 */
export function encodeSpan(span: TraceSpan, sourceId: string, maxBytes: number): Uint8Array {
  if (span.endTime === null || span.completionCursor === null) throw new DeliveryError('TRAJECTORY_SPAN_OPEN', false)
  const resource = resourceFromAttributes({ 'service.name': 'dsh-course-trajectories', 'dsh.source.id': sourceId })
  const value: ReadableSpan = {
    name: span.name, kind: 0,
    spanContext: () => ({ traceId: span.traceId, spanId: span.spanId, traceFlags: 1 }),
    ...span.parentSpanId === null ? {} : {
      parentSpanContext: { traceId: span.traceId, spanId: span.parentSpanId, traceFlags: 1 },
    },
    startTime: time(span.startTime), endTime: time(span.endTime), duration: time(span.endTime - span.startTime),
    status: { code: span.status === 'error' || span.status === 'blocked' ? 2 : span.status === 'completed' ? 1 : 0 },
    attributes: {
      'dsh.trajectory.schema': 1,
      'dsh.course.installation.id': span.identity.installationId,
      'dsh.course.student.id': span.identity.studentId,
      'dsh.course.cohort.id': span.identity.cohortId,
      'dsh.session.id': span.sessionId,
      'dsh.span.kind': span.kind,
      'dsh.span.status': span.status,
      'dsh.span.first_record_id': span.firstRecordId,
      'dsh.span.last_record_id': span.lastRecordId,
      // The JSON string preserves selected nested facts without SDK attribute coercion or clipping.
      'dsh.span.attributes.json': JSON.stringify(span.attributes),
      ...span.turn === null ? {} : { 'dsh.turn': span.turn },
      ...span.parentSessionId === null ? {} : { 'dsh.parent_session.id': span.parentSessionId },
      ...span.parentTraceId === null ? {} : { 'dsh.parent_trace.id': span.parentTraceId },
    },
    // A parent trace ID alone does not identify an initiating parent span, so it is not an OTel Link.
    links: [], events: [], ended: true, resource,
    instrumentationScope: { name: 'dsh.trajectory.projection', version: '1' },
    droppedAttributesCount: 0, droppedEventsCount: 0, droppedLinksCount: 0,
  }
  const request = ProtobufTraceSerializer.serializeRequest([value])
  if (request === undefined || request.byteLength > maxBytes) throw new DeliveryError('TRAJECTORY_REQUEST_TOO_LARGE', false)
  return request
}
