import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteCollector from '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
import type { CollectorIdentity, InstallationId, StudentId, CohortId, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import Projection, { type Config, ProjectionError } from '../src/index.ts'
import type { TraceId, TraceListQuery } from '../src/types.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
const identity: CollectorIdentity = {
  installationId: brandString<InstallationId>('installation'), studentId: brandString<StudentId>('student'), cohortId: brandString<CohortId>('cohort'),
}
const sessionId = SessionId('session')
const query: TraceListQuery = { after: 0, limit: 128, direction: 'oldest' }
function header(session = sessionId, parentSession?: string): TrajectoryRecord {
  return { sessionId: session, sequence: -1, type: 'session/header', timestamp: 1,
    content: JSON.stringify({ header: { id: session, createdAt: 1, isSeeded: false, version: 4,
      ...parentSession === undefined ? {} : { parentSession } }, inheritedEventCount: 0 }) }
}
function event(sequence: number, type: string, data: unknown = {}, session = sessionId, time = sequence + 10): TrajectoryRecord {
  return { sessionId: session, sequence, type, timestamp: time, content: JSON.stringify({ seq: sequence, type, time, data }) }
}
async function directory() { const root = await mkdtemp(join(tmpdir(), 'dsh-projection-')); roots.push(root); return root }
async function boot(config: Partial<Config> = {}, root?: string, prepare?: (ctx: Context, root: string) => Promise<void>) {
  root ??= await directory()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, collector: SqliteCollector, projection: Projection })
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:collector', config: { path: join(root, 'collector.sqlite') } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  await prepare?.(ctx, root)
  const projectionFile = join(root, 'projection.yml')
  await writeFile(projectionFile, JSON.stringify([
    { name: 'cordis:projection', config: { path: join(root, 'projection.sqlite'), pollIntervalMs: 1, ...config } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(projectionFile).href } })
  await ctx.loader.await()
  return { ctx, root, collector: ctx.trajectoryCollector, projection: ctx.trajectoryProjection }
}
async function projected(projection: Context['trajectoryProjection'], cursor: number) {
  await vi.waitFor(async () =>{  expect((await projection.status()).collectorCursor).toBe(cursor) })
}
async function failed(projection: Context['trajectoryProjection'], code = 'PROJECTION_SOURCE') {
  await vi.waitFor(async () =>{  expect(await projection.status()).toMatchObject({ state: 'failed', errorCode: code }) })
}

describe('trajectory projection through a real Loader and durable collector', () => {
  it('projects timed model/tool/scope spans, child linkage, stable IDs and immutable export rows across restarts', async () => {
    const { ctx, root, collector, projection } = await boot({ recordsPerPoll: 2 })
    await collector.append(identity, header())
    const records = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'step/start', { turn: 1, step: 0 }),
      event(2, 'assistant/message', { turn: 1, step: 0, stream: [{ type: 'text-chunks', time0: 10, index: 0, dt: [1], texts: ['a', 'b'] }] }),
      event(3, 'tool/call', { turn: 1, step: 0, callId: 'call', name: 'browser_navigate', arguments: '{"url":"https://widgets.test"}' }),
      event(4, 'plugin:network-scope-guard/judge', { callId: 'call', tool: 'browser_navigate', allowed: false, code: 'SCOPE_DENIED' }),
      event(5, 'tool/result', { turn: 1, step: 0, message: { toolCallId: 'call', isError: true }, error: { code: 'SCOPE_DENIED' } }),
      event(6, 'subagent/catalog', { childId: 'child', childCreatedAt: 1, version: 0, mode: 'continuable' }),
      event(7, 'step/end', { turn: 1, step: 0 }),
      event(8, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ]
    for (const record of records) await collector.append(identity, record)
    await collector.append(identity, header(SessionId('child'), 'session'))
    await collector.append(identity, event(0, 'turn/start', { turn: 1 }, SessionId('child')))
    await collector.append(identity, event(1, 'subagent/descriptor', { version: 3, mode: 'continuable', label: 'Research child' }, SessionId('child')))
    await collector.append(identity, event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, SessionId('child')))
    await projected(projection, 14)
    const page = await projection.list(query)
    expect(page.traces).toHaveLength(2)
    const trace = page.traces[0]!
    const expected = createHash('sha256').update(JSON.stringify(['installation', 'session', 1])).digest('hex').slice(0, 32)
    expect(trace).toMatchObject({ traceId: expected, name: 'Turn 1', status: 'blocked', startTime: 10, endTime: 18, firstCursor: 2, lastCursor: 10 })
    expect(page.traces[1]).toMatchObject({ name: 'Research child · Turn 1', parentSessionId: 'session', parentTraceId: expected })
    const detail = await projection.detail({ traceId: trace.traceId, after: 0, limit: 128 })
    expect(detail.spans.find(span => span.kind === 'model')).toMatchObject({ startTime: 10, endTime: 12, status: 'completed' })
    expect(detail.spans.find(span => span.kind === 'tool')).toMatchObject({ status: 'blocked', startTime: 13, endTime: 15, attributes: { scopeAllowed: false, scopeCode: 'SCOPE_DENIED', errorCode: 'SCOPE_DENIED' } })
    expect(detail.spans.find(span => span.kind === 'scope')).toMatchObject({ status: 'blocked', attributes: { allowed: false, code: 'SCOPE_DENIED', attribution: 'pending-tool-call' } })
    const complete = await projection.readCompleted({ after: 0, limit: 128, maxBytes: 4 * 1024 * 1024 })
    expect(complete.spans.every(span => span.completionCursor !== null && span.endTime !== null)).toBe(true)
    expect(new Set(complete.spans.map(span => span.completionCursor)).size).toBe(complete.spans.length)
    const status = await projection.status()
    await ctx.fiber.dispose()
    await expect(projection.status()).rejects.toHaveProperty('code', 'PROJECTION_UNAVAILABLE')
    const reopened = await boot({}, root)
    await projected(reopened.projection, 14)
    expect((await reopened.projection.status()).projectionId).toBe(status.projectionId)
    expect(await reopened.projection.list(query)).toEqual(page)
    expect(await reopened.projection.readCompleted({ after: 0, limit: 128, maxBytes: 4 * 1024 * 1024 })).toEqual(complete)
  })

  it('provides keyset pages, literal search, exact identity/status filters, and bounded complete outputs', async () => {
    const { collector, projection } = await boot()
    await collector.append(identity, header())
    for (const record of [event(0, 'turn/start', { turn: 1 }), event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), event(2, 'turn/start', { turn: 2 })]) await collector.append(identity, record)
    await projected(projection, 4)
    const first = await projection.list({ ...query, direction: 'newest', limit: 1 })
    expect(first.traces[0]?.turn).toBe(2)
    expect(first.hasMore).toBe(true)
    expect((await projection.list({ ...query, direction: 'newest', after: first.nextCursor })).traces[0]?.turn).toBe(1)
    expect((await projection.list({ ...query, filters: { search: 'TURN 1', installationId: identity.installationId, studentId: identity.studentId, cohortId: identity.cohortId, sessionId, status: 'completed' } })).traces).toHaveLength(1)
    expect((await projection.list({ ...query, filters: { search: "' OR 1=1 --" } })).traces).toEqual([])
    const traceId = first.traces[0]!.traceId
    const detail = await projection.detail({ traceId, after: 0, limit: 1 })
    expect(detail.hasMore).toBe(true)
    expect((await projection.detail({ traceId, after: detail.nextCursor, limit: 1 })).spans[0]?.cursor).toBeGreaterThan(detail.nextCursor)
    const missing = await projection.detail({ traceId: brandString<TraceId>('absent'), after: 0, limit: 1 })
    expect(missing).toEqual({ trace: undefined, spans: [], nextCursor: 0, hasMore: false })
    const completed = await projection.readCompleted({ after: 0, limit: 1, maxBytes: 10000 })
    expect(completed.hasMore).toBe(true)
    const remaining = await projection.readCompleted({ after: completed.nextCursor, limit: 128, maxBytes: 100000 })
    expect(remaining.spans.every(span => span.completionCursor > completed.nextCursor)).toBe(true)
    const size = Buffer.byteLength(JSON.stringify(completed))
    expect(await projection.readCompleted({ after: 0, limit: 1, maxBytes: size })).toEqual(completed)
    await expect(projection.readCompleted({ after: 0, limit: 1, maxBytes: size - 1 })).rejects.toHaveProperty('code', 'PROJECTION_QUOTA')
    for (const invalid of [{ after: -1 }, { limit: 0 }, { limit: 129 }, { direction: 'wrong' as 'newest' }, { filters: { search: '界'.repeat(100) } }]) await expect(projection.list({ ...query, ...invalid })).rejects.toHaveProperty('code', 'PROJECTION_INPUT')
    for (const maxBytes of [0, 4 * 1024 * 1024 + 1]) await expect(projection.readCompleted({ after: 0, limit: 1, maxBytes })).rejects.toHaveProperty('code', 'PROJECTION_INPUT')
    expect((await projection.status()).state).not.toBe('failed')
  })

  it('keeps running spans out of export and records open-tool interruption, model failures, and clock regression explicitly', async () => {
    const { collector, projection } = await boot()
    await collector.append(identity, header())
    await collector.append(identity, event(0, 'turn/start', { turn: 1 }))
    await collector.append(identity, event(1, 'tool/call', { turn: 1, step: 0, callId: 'open', name: 'terminal', arguments: '{}' }))
    await projected(projection, 3)
    expect((await projection.readCompleted({ after: 0, limit: 128, maxBytes: 100000 })).spans.some(span => span.kind === 'tool')).toBe(false)
    await collector.append(identity, event(2, 'assistant/attempt', { turn: 1, step: 0, stream: [] }))
    await collector.append(identity, event(3, 'assistant/message', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 100, chunk: { type: 'finish', reason: { kind: 'error' } } }] }))
    await collector.append(identity, event(4, 'turn/end', { turn: 1, reason: { kind: 'aborted' } }, sessionId, 5))
    await projected(projection, 6)
    const complete = await projection.readCompleted({ after: 0, limit: 128, maxBytes: 100000 })
    expect(complete.spans.find(span => span.kind === 'tool')).toMatchObject({ status: 'incomplete', attributes: { endReason: 'aborted', clockRegressed: true } })
    expect(complete.spans.filter(span => span.kind === 'model').map(span => span.status)).toEqual(['error', 'error'])
    expect(complete.spans.find(span => span.startTime === 100)).toMatchObject({
      endTime: 100, attributes: { recordedEndTime: 13, clockRegressed: true },
    })
    expect((await projection.list(query)).traces[0]).toMatchObject({ status: 'incomplete', startTime: 10, endTime: 10 })
  })

  it('retains unknown events and shared-environment scope metadata without inventing tool attribution', async () => {
    const { collector, projection } = await boot()
    await collector.append(identity, header())
    for (const record of [event(0, 'plugin:unknown/value', []), event(1, 'plugin:network-scope-guard/boundary', {}), event(2, 'plugin:network-scope-guard/network', {}), event(3, 'plugin:network-scope-guard/unavailable', { code: 'SCOPE_UNAVAILABLE' })]) await collector.append(identity, record)
    await projected(projection, 5)
    const trace = (await projection.list(query)).traces[0]!
    expect(trace).toMatchObject({ turn: null, name: 'Session activity', status: 'error' })
    const spans = (await projection.detail({ traceId: trace.traceId, after: 0, limit: 128 })).spans
    expect(spans.filter(span => span.kind === 'scope').map(span => span.attributes.attribution)).toEqual(['shared-environment', 'shared-environment', undefined])
    expect(spans.find(span => span.name === 'plugin:unknown/value')?.kind).toBe('event')
  })

  it('projects allowed and ordinary tool settlements without rewriting already completed spans', async () => {
    const { collector, projection } = await boot()
    await collector.append(identity, header())
    const records = [
      event(0, 'turn/start', { turn: 1 }),
      event(1, 'plugin:network-scope-guard/judge', { callId: 'unmatched', tool: 'browser', allowed: true, code: 'SCOPE_READY' }),
      event(2, 'tool/call', { turn: 1, callId: 'ok', name: 'browser' }),
      event(3, 'tool/result', { turn: 1, message: { toolCallId: 'ok' } }),
      event(4, 'plugin:network-scope-guard/judge', { callId: 'ok', tool: 'browser', allowed: true, code: 'SCOPE_READY' }),
      event(5, 'tool/call', { turn: 1, callId: 'error', name: 'browser' }),
      event(6, 'tool/result', { turn: 1, message: { toolCallId: 'error', isError: true } }),
      event(7, 'assistant/message', { turn: 1, step: 0, stream: [{ type: 'chunk', time: 10, chunk: {} }, { type: 'text-chunks', time0: 11 }] }),
      event(8, 'turn/end', { turn: 1, reason: { kind: 'error' } }),
      event(9, 'turn/start', { turn: 2 }), event(10, 'turn/end', { turn: 2, reason: { kind: 'blocked' } }),
    ]
    for (const record of records) await collector.append(identity, record)
    await projected(projection, 12)
    expect((await projection.list(query)).traces.map(trace => trace.status)).toEqual(['error', 'blocked'])
    const complete = await projection.readCompleted({ after: 0, limit: 128, maxBytes: 100000 })
    expect(complete.spans.filter(span => span.kind === 'tool').map(span => span.status)).toEqual(['completed', 'error'])
    expect(complete.spans.find(span => span.name === 'browser' && span.status === 'completed')?.attributes.scopeAllowed).toBeUndefined()
    const tail = await projection.readCompleted({ after: complete.nextCursor, limit: 128, maxBytes: 100000 })
    expect(tail).toMatchObject({ spans: [], nextCursor: complete.nextCursor, hasMore: false })
    expect((await projection.list({ ...query, after: 999 })).traces).toEqual([])
  })

  it('limits concurrently open spans and never mutates an already settled tool on duplicate results', async () => {
    const bounded = await boot({ maxOpenSpansPerTrace: 2 })
    for (const record of [header(), event(0, 'turn/start', { turn: 1 }), event(1, 'tool/call', { turn: 1, callId: 'a', name: 'a' }), event(2, 'tool/call', { turn: 1, callId: 'b', name: 'b' })]) await bounded.collector.append(identity, record)
    await failed(bounded.projection, 'PROJECTION_QUOTA')
    expect((await bounded.projection.status()).collectorCursor).toBe(3)
    const replay = await boot()
    for (const record of [header(), event(0, 'turn/start', { turn: 1 }), event(1, 'tool/call', { turn: 1, callId: 'a', name: 'a' }), event(2, 'tool/result', { turn: 1, message: { toolCallId: 'a' } }), event(3, 'tool/result', { turn: 1, message: { toolCallId: 'a' } })]) await replay.collector.append(identity, record)
    await failed(replay.projection)
    expect((await replay.projection.status()).collectorCursor).toBe(4)
    const duplicate = await boot()
    for (const record of [header(), event(0, 'tool/call', { turn: 1, callId: 'same', name: 'a' }), event(1, 'tool/call', { turn: 1, callId: 'same', name: 'a' })]) await duplicate.collector.append(identity, record)
    await failed(duplicate.projection)
    expect((await duplicate.projection.status()).collectorCursor).toBe(2)
  })

  it.each(['completionCursor', 'endTime'])('refuses corrupted completed-span %s metadata instead of emitting an open OTLP span', async (field) => {
    const current = await boot()
    await current.collector.append(identity, header())
    await current.collector.append(identity, event(0, 'turn/start', { turn: 1 }))
    await projected(current.projection, 2)
    const db = new DatabaseSync(join(current.root, 'projection.sqlite'))
    db.prepare(`UPDATE spans SET data=json_set(data,'$.${field}',NULL) WHERE completed IS NOT NULL`).run()
    db.close()
    await expect(current.projection.readCompleted({ after: 0, limit: 128, maxBytes: 100000 })).rejects.toHaveProperty('code', 'PROJECTION_STORAGE')
    await failed(current.projection, 'PROJECTION_STORAGE')
  })

  it.each(['missing-header', 'changed-envelope'])('rejects durable event corruption: %s', async (mode) => {
    const { projection } = await boot({}, undefined, async (ctx, root) => {
      await ctx.trajectoryCollector.append(identity, header())
      const db = new DatabaseSync(join(root, 'collector.sqlite'))
      const record = event(0, 'turn/start', { turn: 1 })
      if (mode === 'missing-header') db.prepare('UPDATE records SET sequence=0,type=?,timestamp=?,content=? WHERE cursor=1').run(record.type, record.timestamp, record.content)
      else {
        db.close()
        await ctx.trajectoryCollector.append(identity, record)
        const changed = new DatabaseSync(join(root, 'collector.sqlite'))
        changed.prepare('UPDATE records SET content=? WHERE cursor=2').run(JSON.stringify({ seq: 99, type: record.type, time: record.timestamp, data: { turn: 1 } }))
        changed.close()
        return
      }
      db.close()
    })
    await failed(projection)
  })

  it.each(['anchor', 'status'])('drains cancellation while awaiting initial %s metadata', async (mode) => {
    let root: string | undefined
    if (mode === 'anchor') {
      const initial = await boot()
      await initial.collector.append(identity, header())
      await projected(initial.projection, 1)
      root = initial.root
      await initial.ctx.fiber.dispose()
    }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let entered!: () => void
    const began = new Promise<void>((resolve) => { entered = resolve })
    const current = await boot({}, root, async (ctx) => {
      if (mode === 'anchor') {
        const read = ctx.trajectoryCollector.read.bind(ctx.trajectoryCollector)
        vi.spyOn(ctx.trajectoryCollector, 'read').mockImplementationOnce(async (query) => { entered(); await gate; return read(query) })
      } else {
        const status = ctx.trajectoryCollector.status.bind(ctx.trajectoryCollector)
        vi.spyOn(ctx.trajectoryCollector, 'status').mockImplementationOnce(async () => { entered(); await gate; return status() })
      }
    })
    await began
    const disposing = current.ctx.fiber.dispose()
    release()
    await disposing
    const db = new DatabaseSync(join(current.root, 'projection.sqlite'), { readOnly: true })
    expect(db.prepare('SELECT cursor FROM projection_state').get()?.cursor).toBe(mode === 'anchor' ? 1 : 0)
    db.close()
  })

  it('reports native open failures without replacing a non-directory ancestor', async () => {
    const root = await directory()
    const path = join(root, 'keep')
    await writeFile(path, 'retained')
    expect(() => new Projection(new Context(), Projection.Config({ path: join(path, 'projection.sqlite') }))).toThrow('PROJECTION_STORAGE')
    expect(await readFile(path, 'utf8')).toBe('retained')
  })

  it.skipIf(process.platform === 'win32')('reports an unwritable database directory without changing its permissions', async () => {
    const root = await directory()
    await chmod(root, 0o500)
    try { expect(() => new Projection(new Context(), Projection.Config({ path: join(root, 'projection.sqlite') }))).toThrow('PROJECTION_STORAGE') }
    finally { await chmod(root, 0o700) }
  })

  it.each(['{bad json', '[]', JSON.stringify({ header: { id: 'wrong' }, inheritedEventCount: 0 }), JSON.stringify({ header: { id: 'session', parentSession: 42 }, inheritedEventCount: 0 }), JSON.stringify({ seq: 0, type: 'turn/start', time: 10, data: { turn: 1 } })])('rejects corrupted durable collector content without projecting it: %s', async (content) => {
    const { projection } = await boot({}, undefined, async (ctx, root) => {
      await ctx.trajectoryCollector.append(identity, header())
      const db = new DatabaseSync(join(root, 'collector.sqlite'))
      db.prepare('UPDATE records SET content=? WHERE cursor=1').run(content)
      db.close()
    })
    await failed(projection)
    expect((await projection.status()).collectorCursor).toBe(0)
  })

  it('detects noncontiguous source records and a regressed source high-water mark', async () => {
    const first = await boot({}, undefined, async (ctx, root) => {
      await ctx.trajectoryCollector.append(identity, header())
      const db = new DatabaseSync(join(root, 'collector.sqlite'))
      db.exec('UPDATE records SET cursor=2; UPDATE collector_state SET last_cursor=2')
      db.close()
    })
    await failed(first.projection)
    const current = await boot()
    await current.collector.append(identity, header())
    await projected(current.projection, 1)
    await current.ctx.fiber.dispose()
    const db = new DatabaseSync(join(current.root, 'collector.sqlite'))
    db.exec('UPDATE collector_state SET last_cursor=0')
    db.close()
    const regressed = await boot({}, current.root)
    await failed(regressed.projection)
    expect((await regressed.projection.status()).collectorCursor).toBe(1)
  })

  it('reports source-provider failures and query storage failures with no background continuation', async () => {
    const bounded = await boot({ sourcePageBytes: 1 })
    await failed(bounded.projection)
    const current = await boot()
    await current.collector.append(identity, header())
    await current.collector.append(identity, event(0, 'turn/start', { turn: 1 }))
    await projected(current.projection, 2)
    const db = new DatabaseSync(join(current.root, 'projection.sqlite'))
    db.exec("UPDATE traces SET data='not JSON'")
    db.close()
    await expect(current.projection.list(query)).rejects.toHaveProperty('code', 'PROJECTION_STORAGE')
    await failed(current.projection, 'PROJECTION_STORAGE')
    await current.collector.append(identity, event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    expect((await current.projection.status()).collectorCursor).toBe(2)
  })

  it('contains native write-lock failures even when persistent failure reporting is also blocked', async () => {
    const current = await boot()
    await vi.waitFor(async () =>{  expect((await current.projection.status()).state).toBe('idle') })
    const db = new DatabaseSync(join(current.root, 'projection.sqlite'))
    try {
      db.exec('BEGIN IMMEDIATE')
      await current.collector.append(identity, header())
      await failed(current.projection, 'PROJECTION_STORAGE')
      expect((await current.projection.status()).collectorCursor).toBe(0)
    } finally { db.exec('ROLLBACK'); db.close() }
  })

  it('contains unexpected filesystem inspection errors and tolerates a missing optional SQLite sidecar', async () => {
    const current = await boot()
    await vi.waitFor(async () =>{  expect((await current.projection.status()).state).toBe('idle') })
    const original = fs.statSync
    const headerCommit = current.collector.append(identity, header())
    vi.spyOn(fs, 'statSync').mockImplementationOnce(original).mockImplementationOnce(() => { throw Object.assign(new Error('missing optional WAL'), { code: 'ENOENT' }) })
    syncBuiltinESMExports()
    await headerCommit
    await projected(current.projection, 1)
    vi.restoreAllMocks(); syncBuiltinESMExports()
    const eventCommit = current.collector.append(identity, event(0, 'turn/start', { turn: 1 }))
    vi.spyOn(fs, 'statSync').mockImplementationOnce(original).mockImplementationOnce(() => { throw Object.assign(new Error('inspection failed'), { code: 'EACCES' }) })
    syncBuiltinESMExports()
    await eventCommit
    await failed(current.projection, 'PROJECTION_STORAGE')
  })

  it('exposes complete-page quota errors without failing indexing and preserves counter overflow protection', async () => {
    const tiny = await boot({ maxQueryBytes: 1 })
    await expect(tiny.projection.list(query)).rejects.toHaveProperty('code', 'PROJECTION_QUOTA')
    const current = await boot()
    await current.collector.append(identity, header())
    await projected(current.projection, 1)
    const db = new DatabaseSync(join(current.root, 'projection.sqlite'))
    db.prepare('UPDATE projection_state SET completed=?').run(Number.MAX_SAFE_INTEGER)
    db.close()
    await current.collector.append(identity, event(0, 'turn/start', { turn: 1 }))
    await failed(current.projection, 'PROJECTION_QUOTA')
    expect((await current.projection.status()).collectorCursor).toBe(1)
  })

  it.each([
    event(0, 'turn/start', { turn: -1 }),
    event(0, 'tool/call', { turn: 1, callId: '', name: 'test' }),
    event(0, 'tool/result', { turn: 1 }),
    event(0, 'tool/result', { turn: 1, message: { toolCallId: 'missing' } }),
    event(0, 'assistant/message', { turn: 1, step: 0 }),
    event(0, 'assistant/message', { turn: 1, step: 0, stream: [null] }),
    event(0, 'assistant/message', { turn: 1, step: 0, stream: [{ time0: -1 }] }),
    event(0, 'plugin:network-scope-guard/judge', { allowed: 'yes' }),
    event(0, 'turn/end', { turn: 1 }),
  ])('stops persistently before an invalid known payload rather than skipping it: %j', async (record) => {
    const { collector, projection, ctx, root } = await boot()
    await collector.append(identity, header())
    await collector.append(identity, record)
    await failed(projection)
    expect(await projection.status()).toMatchObject({ collectorCursor: 1, traces: 0, spans: 0 })
    await ctx.fiber.dispose()
    const reopened = await boot({}, root)
    expect(await reopened.projection.status()).toMatchObject({ state: 'failed', errorCode: 'PROJECTION_SOURCE', collectorCursor: 1 })
  })

  it.each([{ maxTraces: 1 }, { maxSpans: 1 }, { maxSpanBytes: 1 }, { minFreeBytes: Number.MAX_SAFE_INTEGER }, { maxDatabaseBytes: 65536 }])('enforces durable intake quotas without acknowledging the rejected record: %j', async (config) => {
    const { collector, projection } = await boot(config)
    await collector.append(identity, header())
    await collector.append(identity, event(0, 'turn/start', { turn: 1 }))
    await collector.append(identity, event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    await collector.append(identity, event(2, 'turn/start', { turn: 2 }))
    await failed(projection, 'PROJECTION_QUOTA')
    expect((await projection.status()).collectorCursor).toBeLessThan(4)
  })

  it('detects a pruned restart anchor and unprojected source gaps without resetting the cursor', async () => {
    const { collector, projection, ctx, root } = await boot()
    await collector.append(identity, header())
    await collector.append(identity, event(0, 'turn/start', { turn: 1 }))
    await projected(projection, 2)
    await ctx.fiber.dispose()
    const store = new DatabaseSync(join(root, 'collector.sqlite'))
    store.exec('UPDATE records SET content=NULL,content_bytes=0 WHERE cursor=2')
    store.close()
    const reopened = await boot({}, root)
    await failed(reopened.projection)
    expect((await reopened.projection.status()).collectorCursor).toBe(2)
    const other = await directory()
    const stopped = await boot({}, other)
    await stopped.collector.append(identity, header())
    await projected(stopped.projection, 1)
    await stopped.ctx.fiber.dispose()
    const changed = new DatabaseSync(join(other, 'collector.sqlite'))
    changed.exec('UPDATE collector_state SET last_cursor=2')
    changed.close()
    const gap = await boot({}, other)
    await failed(gap.projection)
    expect((await gap.projection.status()).collectorCursor).toBe(1)
  })

  it('drains an in-flight source read and prevents its late completion from mutating projection state after disposal', async () => {
    const { collector, projection, ctx, root } = await boot()
    await vi.waitFor(async () =>{  expect((await projection.status()).state).toBe('idle') })
    let unblock!: () => void
    const gate = new Promise<void>((resolve) => { unblock = resolve })
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const read = collector.read.bind(collector)
    vi.spyOn(collector, 'read').mockImplementationOnce(async (value) => { entered(); await gate; return read(value) })
    await started
    const disposing = ctx.fiber.dispose()
    unblock()
    await disposing
    const db = new DatabaseSync(join(root, 'projection.sqlite'), { readOnly: true })
    expect(db.prepare('SELECT cursor FROM projection_state').get()?.cursor).toBe(0)
    db.close()
  })

  it.skipIf(process.platform === 'win32')('uses owner-only files and rejects foreign or linked storage without replacement', async () => {
    const { ctx, root } = await boot()
    expect((await stat(join(root, 'projection.sqlite'))).mode & 0o777).toBe(0o600)
    await ctx.fiber.dispose()
    const foreign = join(root, 'foreign.sqlite')
    const db = new DatabaseSync(foreign)
    db.exec('CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES(\'keep\')')
    db.close()
    await chmod(foreign, 0o600)
    const before = await readFile(foreign)
    expect(() => new Projection(new Context(), Projection.Config({ path: foreign }))).toThrow('foreign')
    expect(await readFile(foreign)).toEqual(before)
    await symlink(foreign, join(root, 'linked.sqlite'))
    expect(() => new Projection(new Context(), Projection.Config({ path: join(root, 'linked.sqlite') }))).toThrow('owner-only')
    expect(() => Projection.Config({ path: 'relative.sqlite' })).toThrow('absolute')
    expect(new ProjectionError('PROJECTION_INPUT', 'invalid').name).toBe('ProjectionError')
  })
})
