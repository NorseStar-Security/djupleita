import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { TraceSpan } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'
import { encodeSpan } from '../src/trace-encoding.ts'
import * as Traces from '../src/traces.ts'
import { decodeSpans } from './trace-protocol.ts'

function span(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    traceId: brandString<TraceSpan['traceId']>('1'.repeat(32)), spanId: brandString<TraceSpan['spanId']>('2'.repeat(16)),
    parentSpanId: null, cursor: 1, completionCursor: 1,
    identity: { installationId: brandString<TraceSpan['identity']['installationId']>('installation'),
      studentId: brandString<TraceSpan['identity']['studentId']>('student'), cohortId: brandString<TraceSpan['identity']['cohortId']>('cohort') },
    sessionId: SessionId('session'), turn: 1, parentSessionId: null, parentTraceId: null, kind: 'turn', name: 'Turn 1',
    startTime: 1000, endTime: 1100, status: 'completed', firstCursor: 1, lastCursor: 2,
    firstRecordId: brandString<TraceSpan['firstRecordId']>('first'), lastRecordId: brandString<TraceSpan['lastRecordId']>('last'),
    attributes: { nested: { text: '安全🔬' } }, ...overrides,
  }
}

describe('immutable projection span encoding', () => {
  it('preserves deterministic IDs, millisecond timestamps, trusted identity, and complete nested facts', () => {
    const value = decodeSpans(encodeSpan(span(), 'archive', 10000))[0]
    expect(value).toMatchObject({ traceId: '1'.repeat(32), spanId: '2'.repeat(16), name: 'Turn 1', kind: 1,
      startTimeUnixNano: '1000000000', endTimeUnixNano: '1100000000', status: { code: 1 },
      attributes: { 'dsh.course.student.id': 'student', 'dsh.span.attributes.json': JSON.stringify({ nested: { text: '安全🔬' } }) } })
    expect(value?.parentSpanId).toBeUndefined()
  })

  it('preserves actual parent IDs and only labels child-session associations that lack an initiating parent span', () => {
    const value = decodeSpans(encodeSpan(span({ parentSpanId: brandString<NonNullable<TraceSpan['parentSpanId']>>('3'.repeat(16)),
      parentSessionId: SessionId('parent'), parentTraceId: brandString<NonNullable<TraceSpan['parentTraceId']>>('4'.repeat(32)),
      turn: null, status: 'incomplete' }), 'archive', 10000))[0]
    expect(value?.parentSpanId).toBe('3'.repeat(16))
    expect(value?.attributes).toMatchObject({ 'dsh.parent_session.id': 'parent', 'dsh.parent_trace.id': '4'.repeat(32) })
    expect(value?.attributes).not.toHaveProperty('dsh.turn')
    expect(value?.links ?? []).toEqual([])
    expect(value?.status.code).toBe(0)
  })

  it.each(['blocked', 'error'] as const)('marks recorded %s spans as OTLP errors', (status) => {
    expect(decodeSpans(encodeSpan(span({ status }), 'archive', 10000))[0]?.status.code).toBe(2)
  })

  it('rejects open spans and excessive complete requests instead of clipping selected facts', () => {
    expect(() => encodeSpan(span({ endTime: null }), 'archive', 10000)).toThrow('TRAJECTORY_SPAN_OPEN')
    expect(() => encodeSpan(span({ completionCursor: null }), 'archive', 10000)).toThrow('TRAJECTORY_SPAN_OPEN')
    expect(() => encodeSpan(span({ attributes: { complete: '🔬'.repeat(1000) } }), 'archive', 1024)).toThrow('TRAJECTORY_REQUEST_TOO_LARGE')
  })

  it('keeps the traces entry separate and requires explicit consent', () => {
    expect(Object.keys(Traces).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
    expect(Traces.inject).toEqual(['trajectoryProjection'])
    expect(() => z.resolve({ endpoint: 'https://receiver.test/v1/traces', tokenFile: '/token', stateDir: '/state', sourceId: 'archive' },
      Traces.Config, {})).toThrow()
  })
})
