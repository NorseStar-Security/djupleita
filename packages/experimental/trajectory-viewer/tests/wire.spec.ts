import { describe, expect, it } from 'vitest'
import { parsePage } from '../src/wire.ts'

type WireObject = Record<string, unknown>
const identity = () => ({ installationId: 'installation', studentId: 'student', cohortId: 'cohort' })
function trace(change: WireObject = {}): WireObject {
  return {
    traceId: 'a'.repeat(32), rootSpanId: 'b'.repeat(16), sessionId: 'session', name: 'Turn 1', status: 'running',
    cursor: 1, startTime: 10, endTime: null, turn: 1, parentSessionId: null, parentTraceId: null,
    firstCursor: 1, lastCursor: 2, identity: identity(), ...change,
  }
}
function span(change: WireObject = {}): WireObject {
  return {
    traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), sessionId: 'session', name: 'browser_navigate', kind: 'tool', status: 'running',
    firstRecordId: 'record-one', lastRecordId: 'record-two', cursor: 1, startTime: 10, endTime: null,
    firstCursor: 1, lastCursor: 2, parentSpanId: null, identity: identity(), attributes: {},
    completionCursor: null, turn: 1, parentSessionId: null, parentTraceId: null, ...change,
  }
}
function record(change: WireObject = {}): WireObject {
  return {
    id: 'record-one', sessionId: 'session', type: 'session/header', content: '{"header":{"label":"<script>界</script>"}}',
    sha256: 'c'.repeat(64), cursor: 1, timestamp: 10, receivedAt: 20, sequence: -1, identity: identity(), ...change,
  }
}
function health(change: WireObject = {}): WireObject {
  return {
    collector: { records: 1, artifacts: 0, contentBytes: 100, lastCursor: 1, exportedCursor: 0,
      revokedInstallations: 0, exportDestination: null },
    projection: { state: 'idle', projectionId: 'projection-generation', collectorCursor: 1, sourceCursor: 1,
      traces: 1, spans: 2, completedCursor: 1, ...change },
  }
}
const page = (key: string, items: unknown[] = []): WireObject => ({ [key]: items, nextCursor: 2, hasMore: false })
function decode(value: unknown): unknown { return JSON.parse(JSON.stringify(value)) }
function reject(kind: string, value: unknown): void {
  expect(() => parsePage(kind, decode(value))).toThrow('VIEWER_INVALID_RESPONSE')
}

describe('trajectory viewer untrusted JSON inspection pages', () => {
  it('admits status counters and every declared projection state without rewriting data', () => {
    for (const state of ['indexing', 'idle', 'failed', 'stopped']) {
      const value = decode(health({ state }))
      expect(parsePage('status', value)).toEqual({ kind: 'status', page: value })
    }
    for (const errorCode of ['PROJECTION_INPUT', 'PROJECTION_SOURCE', 'PROJECTION_STORAGE', 'PROJECTION_QUOTA', 'PROJECTION_UNAVAILABLE']) {
      const value = decode(health({ state: 'failed', errorCode }))
      expect(parsePage('status', value)).toEqual({ kind: 'status', page: value })
    }
  })

  it('admits trace status, timing, turn, identity and parent labels from JSON', () => {
    const values = ['running', 'completed', 'blocked', 'error', 'incomplete'].map(status => trace({ status }))
    values.push(trace({ endTime: 15, turn: null, parentSessionId: 'parent', parentTraceId: 'd'.repeat(32) }))
    const value = decode(page('traces', values))
    expect(parsePage('traces', value)).toEqual({ kind: 'traces', page: value })
    expect(parsePage('traces', decode(page('traces')))).toEqual({ kind: 'traces', page: page('traces') })
  })

  it('admits missing detail and all recorded span kinds while preserving attributes and exact source bytes', () => {
    expect(parsePage('detail', decode(page('spans')))).toEqual({ kind: 'detail', page: page('spans') })
    const spans = ['turn', 'model', 'tool', 'scope', 'event'].map(kind => span({ kind }))
    spans.push(span({ status: 'completed', endTime: 15, parentSpanId: 'd'.repeat(16),
      attributes: { code: 'SCOPE_DENIED', allowed: false, nested: [null, '界', { exact: '<script>data</script>' }] } }))
    const detail = decode({ ...page('spans', spans), trace: trace() })
    expect(parsePage('detail', detail)).toEqual({ kind: 'detail', page: detail })
    const records = decode(page('records', [record(), record({ sequence: 0, type: 'turn/start', content: '{"exact":"\\n界"}' })]))
    expect(parsePage('records', records)).toEqual({ kind: 'records', page: records })
  })

  it.each([null, [], 'text', 1, false])('rejects a non-object root %j for every endpoint', (value) => {
    for (const kind of ['status', 'traces', 'detail', 'records']) reject(kind, value)
  })

  it('rejects malformed status objects, missing counters, invalid numbers and unknown states', () => {
    for (const value of [
      {}, { collector: [], projection: health().projection }, { collector: health().collector },
      { ...health(), collector: { records: '1', artifacts: 0, contentBytes: 0, lastCursor: 0, exportedCursor: 0, revokedInstallations: 0 } },
      { ...health(), collector: { records: 0, artifacts: -1, contentBytes: 0, lastCursor: 0, exportedCursor: 0, revokedInstallations: 0 } },
      health({ state: 'unknown' }), health({ state: 1 }), health({ projectionId: null }),
      health({ sourceCursor: 0.5 }), health({ spans: Number.MAX_SAFE_INTEGER + 1 }),
    ]) reject('status', value)
  })

  it.each([null, 1, false, [], {}, 'UNRECOGNIZED_ERROR'])('rejects a projection error code that cannot safely be rendered: %j', (errorCode) => {
    reject('status', health({ errorCode }))
  })

  it('rejects malformed pagination, wrong collections and pages beyond the endpoint item limit', () => {
    for (const [kind, key] of [['traces', 'traces'], ['detail', 'spans'], ['records', 'records']] as const) {
      for (const value of [
        {}, { ...page(key), nextCursor: '2' }, { ...page(key), nextCursor: -1 },
        { ...page(key), nextCursor: 0.5 }, { ...page(key), nextCursor: Number.MAX_SAFE_INTEGER + 1 },
        { ...page(key), hasMore: 1 }, { ...page(key), [key]: {} }, { ...page(key), [key]: null },
        page(key, Array.from({ length: 101 }, () => null)),
      ]) reject(kind, value)
    }
    const atLimit = decode(page('traces', Array.from({ length: 100 }, () => trace())))
    expect(parsePage('traces', atLimit)).toEqual({ kind: 'traces', page: atLimit })
  })

  it.each([
    { traceId: 'A'.repeat(32) }, { traceId: 'a'.repeat(31) }, { rootSpanId: 'g'.repeat(16) },
    { status: 'unknown' }, { status: null }, { endTime: '10' }, { turn: '1' }, { turn: 0.5 },
    { parentSessionId: {} }, { parentTraceId: [] }, { identity: null },
    { identity: { ...identity(), studentId: 1 } }, { name: 1 }, { cursor: -1 }, { startTime: 0.5 },
  ])('rejects malformed trace fields %j in both trace listings and detail', (change) => {
    reject('traces', page('traces', [trace(change)]))
    reject('detail', { ...page('spans'), trace: trace(change) })
  })

  it('rejects non-object trace/span/record items rather than publishing a partial page', () => {
    for (const value of [null, [], 'item', 1]) {
      reject('traces', page('traces', [trace(), value]))
      reject('detail', page('spans', [span(), value]))
      reject('records', page('records', [record(), value]))
    }
  })

  it.each([
    { traceId: 'z'.repeat(32) }, { spanId: 'b'.repeat(15) }, { kind: 'network-guess' }, { status: 'unknown' },
    { endTime: '20' }, { parentSpanId: 1 }, { identity: [] }, { identity: { ...identity(), cohortId: null } },
    { attributes: null }, { attributes: [] }, { lastRecordId: false }, { firstCursor: -1 },
  ])('rejects malformed span fields %j', (change) => {
    reject('detail', page('spans', [span(change)]))
  })

  it('rejects nonfinite JSON exponent timing values for traces and spans', () => {
    const tracePage: unknown = JSON.parse(JSON.stringify(page('traces', [trace({ endTime: 'overflow' })])).replace('"overflow"', '1e309'))
    const spanPage: unknown = JSON.parse(JSON.stringify(page('spans', [span({ endTime: 'overflow' })])).replace('"overflow"', '-1e309'))
    expect(() => parsePage('traces', tracePage)).toThrow('VIEWER_INVALID_RESPONSE')
    expect(() => parsePage('detail', spanPage)).toThrow('VIEWER_INVALID_RESPONSE')
  })

  it.each([
    { sequence: '0' }, { sequence: -2 }, { sequence: 0.5 }, { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { content: {} }, { sha256: 1 }, { receivedAt: -1 }, { identity: false }, { identity: { ...identity(), installationId: [] } },
  ])('rejects malformed source records %j', (change) => {
    reject('records', page('records', [record(change)]))
  })

  it('rejects endpoint names outside the owned inspection protocol', () => {
    for (const kind of ['', 'unknown', 'Status', 'delete', '__proto__']) {
      expect(() => parsePage(kind, decode({}))).toThrow('VIEWER_INVALID_ADDRESS')
    }
  })
})
