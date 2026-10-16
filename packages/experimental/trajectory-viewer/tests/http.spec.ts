import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer, { type IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteCollector from '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
import type { CollectorIdentity, CollectorPage, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import Projection, { type Config as ProjectionConfig } from '@deepseek-ai/dsh-experimental-trajectory-projection'
import type { TraceDetailPage, TraceListPage } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'
import * as Viewer from '../src/index.ts'
import { ViewerHttp } from '../src/http.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw new AggregateError(failures, 'trajectory viewer fixture cleanup failed')
})

const identity: CollectorIdentity = {
  installationId: 'installation-one' as CollectorIdentity['installationId'],
  studentId: 'student-one' as CollectorIdentity['studentId'],
  cohortId: 'cohort-one' as CollectorIdentity['cohortId'],
}
const sessionId = SessionId('research-session')
function header(session = sessionId, parentSession?: string): TrajectoryRecord {
  return { sessionId: session, sequence: -1, type: 'session/header', timestamp: 1,
    content: JSON.stringify({ header: { id: session, createdAt: 1, isSeeded: false, version: 4,
      ...parentSession === undefined ? {} : { parentSession } }, inheritedEventCount: 0 }) }
}
function event(sequence: number, type: string, data: unknown, session = sessionId): TrajectoryRecord {
  return { sessionId: session, sequence, type, timestamp: sequence + 10,
    content: JSON.stringify({ seq: sequence, type, time: sequence + 10, data }) }
}
function barrier() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function composition(projectionConfig: Partial<ProjectionConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'trajectory-viewer-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, web: WebServer, collector: SqliteCollector, projection: Projection,
    credentials: CredentialsLocal, connection: Connection, viewer: Viewer,
  })
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { name: 'cordis:collector', config: { path: join(root, 'collector', 'collector.sqlite') } },
    { name: 'cordis:projection', config: {
      path: join(root, 'projection', 'projection.sqlite'), pollIntervalMs: 1, ...projectionConfig,
    } },
    { name: 'cordis:credentials', config: { path: join(root, 'credentials.yaml'), dshHome: root, watch: false } },
    { name: 'cordis:connection' },
    { id: 'trajectory-viewer', name: 'cordis:viewer' },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  expect(unloaded.map(entry => entry.options.name)).toEqual([])
  const origin = ctx.webServer.getOrigin()
  const launch = new URL(ctx.connection.authenticatedUrl(origin))
  let cookie = ''
  ctx.connection.authorizeIndex({ method: 'GET', url: `${launch.pathname}${launch.search}`, headers: { host: launch.host } }, {
    writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] ?? '' }, end() {},
  })
  expect(cookie).not.toBe('')
  const get = (path: string) => fetch(`${origin}/api/trajectory-viewer/${path}`, { headers: { cookie } })
  const append = async (records: TrajectoryRecord[], sourceIdentity = identity) => {
    for (const record of records) await ctx.trajectoryCollector.append(sourceIdentity, record)
    const cursor = (await ctx.trajectoryCollector.status()).lastCursor
    await vi.waitFor(async () => {
      expect(await ctx.trajectoryProjection.status()).toMatchObject({ collectorCursor: cursor, state: 'idle' })
    })
  }
  return { ctx, origin, cookie, get, append }
}

describe('trajectory viewer through real Loader, SQLite projection, collector, and Connection', () => {
  it('keeps a namespace function plugin and requires all four inspection dependencies', () => {
    expect(Object.keys(Viewer).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
    expect(Viewer.inject).toEqual(['webServer', 'connection', 'trajectoryCollector', 'trajectoryProjection'])
    expect(Viewer.Config()).toEqual({ pollIntervalMs: 1500, apiBasePath: 'api/trajectory-viewer/' })
    for (const pollIntervalMs of [0, 999, 60001, 1000.5]) expect(() => Viewer.Config({ pollIntervalMs })).toThrow()
  })

  it('authenticates every route before query handling and rejects cross-origin or rebound requests', async () => {
    const { ctx, origin, cookie, get } = await composition()
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table)
    expect(table).toContainEqual({ kind: 'global', name: '__DSH_TRAJECTORY_VIEWER_CONFIG__', value: { pollIntervalMs: 1500, apiBasePath: 'api/trajectory-viewer/' } })
    for (const action of ['status', 'traces', 'detail', 'records']) {
      const url = `${origin}/api/trajectory-viewer/${action}?unexpected=secret`
      expect((await fetch(url)).status).toBe(401)
      for (const headers of [{ origin: 'https://untrusted.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }]) {
        expect((await fetch(url, { headers: { cookie, ...headers } })).status).toBe(403)
      }
      const rebound = await new Promise<number>((resolve, reject) => {
        const req = request(url, { headers: { cookie, host: 'attacker.test' } }, (res) => {
          res.resume(); res.once('end', () => { resolve(Number(res.statusCode)) })
        })
        req.once('error', reject); req.end()
      })
      expect(rebound).toBe(403)
    }
    const status = await get('status')
    expect(status.status).toBe(200)
    expect(status.headers.get('cache-control')).toBe('no-store')
    expect(status.headers.get('x-content-type-options')).toBe('nosniff')
    expect(status.headers.get('content-type')).toBe('application/json')
  })

  it('exposes no upload, delete, or control method and leaves the committed archive unchanged', async () => {
    const { ctx, origin, cookie, get, append } = await composition()
    await append([header(), event(0, 'turn/start', { turn: 1 })])
    const before = await ctx.trajectoryCollector.status()
    const page = await ctx.trajectoryCollector.read({ after: 0, limit: 100, maxBytes: 1048576 })
    for (const action of ['status', 'traces', 'detail', 'records']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        const response = await fetch(`${origin}/api/trajectory-viewer/${action}`, { method, headers: { cookie } })
        expect(response.status).toBe(405)
        expect(response.headers.get('allow')).toBe('GET')
      }
    }
    expect((await get('records')).status).toBe(200)
    expect(await ctx.trajectoryCollector.status()).toEqual(before)
    expect(await ctx.trajectoryCollector.read({ after: 0, limit: 100, maxBytes: 1048576 })).toEqual(page)
  })

  it('renders blocked tool/scope traces and child linkage while returning exact complete source records', async () => {
    const { ctx, get, append } = await composition()
    const child = SessionId('research-child')
    const records = [
      header(), event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 0 }),
      event(2, 'assistant/message', { turn: 1, step: 0, stream: [{ type: 'text-chunks', time0: 10, index: 0, dt: [1], texts: ['reasoning', 'done'] }] }),
      event(3, 'tool/call', { turn: 1, step: 0, callId: 'browser-call', name: 'browser_navigate', arguments: '{"url":"https://widgets.test/<script>界</script>"}' }),
      event(4, 'plugin:network-scope-guard/judge', { callId: 'browser-call', tool: 'browser_navigate', allowed: false, code: 'SCOPE_DENIED' }),
      event(5, 'tool/result', { turn: 1, step: 0, message: { toolCallId: 'browser-call', isError: true }, error: { code: 'SCOPE_DENIED' } }),
      event(6, 'subagent/catalog', { childId: child, childCreatedAt: 1, version: 0, mode: 'continuable' }),
      event(7, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      header(child, sessionId), event(0, 'turn/start', { turn: 1 }, child),
      event(1, 'subagent/descriptor', { version: 3, mode: 'continuable', label: 'Child research' }, child),
      event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, child),
    ]
    await append(records)
    const listed = await (await get('traces')).json() as TraceListPage
    expect(listed.traces).toHaveLength(2)
    const parent = listed.traces.find(trace => trace.sessionId === sessionId)!
    const descendant = listed.traces.find(trace => trace.sessionId === child)!
    expect(parent).toMatchObject({ name: 'Turn 1', status: 'blocked', startTime: 10, endTime: 17, identity })
    expect(descendant).toMatchObject({ name: 'Child research · Turn 1', parentSessionId: sessionId, parentTraceId: parent.traceId })
    const detail = await (await get(`detail?traceId=${parent.traceId}`)).json() as TraceDetailPage
    expect(detail.spans.find(span => span.kind === 'tool')).toMatchObject({ status: 'blocked', attributes: { callId: 'browser-call', scopeAllowed: false, scopeCode: 'SCOPE_DENIED' } })
    expect(detail.spans.find(span => span.kind === 'scope')).toMatchObject({ status: 'blocked', attributes: { allowed: false, attribution: 'pending-tool-call' } })
    const raw = await (await get('records')).json() as CollectorPage
    expect(raw.records.map(record => record.content)).toEqual(records.map(record => record.content))
    for (const [index, record] of raw.records.entries()) {
      expect(record.identity).toEqual(identity)
      expect(record.sha256).toBe(createHash('sha256').update(records[index]!.content).digest('hex'))
    }
    expect(await ctx.trajectoryCollector.read({ after: 0, limit: 100, maxBytes: 1048576 })).toEqual(raw)
    expect(await (await get('status')).json()).toMatchObject({ collector: { records: records.length, exportedCursor: 0 }, projection: { collectorCursor: records.length, traces: 2 } })
  })

  it('pages committed trace/span/source identities and applies literal exact filters', async () => {
    const { get, append } = await composition()
    await append([header(), event(0, 'turn/start', { turn: 1 }), event(1, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), event(2, 'turn/start', { turn: 2 })])
    const first = await (await get('traces?limit=1')).json() as TraceListPage
    expect(first.traces[0]?.turn).toBe(2)
    expect(first.hasMore).toBe(true)
    const second = await (await get(`traces?limit=1&after=${first.nextCursor}`)).json() as TraceListPage
    expect(second.traces[0]?.turn).toBe(1)
    expect(second.hasMore).toBe(false)
    const filtered = await (await get('traces?installationId=installation-one&studentId=student-one&cohortId=cohort-one&sessionId=research-session&status=completed&search=TURN%201')).json() as TraceListPage
    expect(filtered.traces.map(trace => trace.turn)).toEqual([1])
    for (const filter of ['installationId=other', 'studentId=other', 'cohortId=other', 'sessionId=other', 'parentSessionId=other', `search=${encodeURIComponent("' OR 1=1 --")}`]) {
      expect((await (await get(`traces?${filter}`)).json() as TraceListPage).traces).toEqual([])
    }
    const detail = await (await get(`detail?traceId=${second.traces[0]!.traceId}&limit=1`)).json() as TraceDetailPage
    expect(detail.hasMore).toBe(true)
    const next = await (await get(`detail?traceId=${second.traces[0]!.traceId}&limit=1&after=${detail.nextCursor}`)).json() as TraceDetailPage
    expect(next.spans[0]!.cursor).toBeGreaterThan(detail.nextCursor)
    expect(await (await get(`detail?traceId=${'0'.repeat(32)}`)).json()).toEqual({ spans: [], nextCursor: 0, hasMore: false })
    const source = await (await get('records?limit=1')).json() as CollectorPage
    expect(source.records[0]?.sequence).toBe(-1)
    expect(source.hasMore).toBe(true)
    const eventPage = await (await get(`records?limit=1&after=${source.nextCursor}&installationId=installation-one&studentId=student-one&cohortId=cohort-one&sessionId=research-session`)).json() as CollectorPage
    expect(eventPage.records[0]?.sequence).toBe(0)
    expect((await (await get('records?studentId=another')).json() as CollectorPage).records).toEqual([])
  })

  it('rejects query widening, duplicate keys, invalid cursors, malformed trace IDs, and UTF-8 search overflow', async () => {
    const { get } = await composition()
    for (const action of ['traces', 'records', 'detail']) {
      for (const query of ['limit=0', 'limit=101', 'limit=01', 'limit=1.5', 'after=-1', 'after=9007199254740992', 'limit=1&limit=2', 'unexpected=x']) {
        const response = await get(`${action}?${query}`)
        expect(response.status, `${action}?${query}`).toBe(400)
        expect(await response.json()).toEqual({ error: 'VIEWER_INVALID_QUERY' })
      }
    }
    for (const query of ['anything=1', 'after=0', 'limit=1']) expect((await get(`status?${query}`)).status).toBe(400)
    for (const query of ['', 'traceId=x', `traceId=${'A'.repeat(32)}`, `traceId=${'a'.repeat(32)}&traceId=${'b'.repeat(32)}`]) expect((await get(`detail?${query}`)).status).toBe(400)
    for (const query of ['status=not-a-status', `search=${encodeURIComponent('é'.repeat(129))}`, `search=${'x'.repeat(257)}`, 'sessionId=bad%00id']) expect((await get(`traces?${query}`)).status).toBe(400)
    expect((await get('records?parentSessionId=other')).status).toBe(400)
    expect((await get('records?search=anything')).status).toBe(400)
  })

  it('rejects the entire oversized multibyte projection page rather than clipping fields or records', async () => {
    const { get, append } = await composition()
    const label = '界'.repeat(250000)
    for (let index = 0; index < 3; index++) {
      const session = SessionId(`large-label-${index}`)
      await append([header(session), event(0, 'subagent/descriptor', { label }, session)])
    }
    const response = await get('traces?limit=3')
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'VIEWER_PAGE_TOO_LARGE' })
    const smaller = await (await get('traces?limit=1')).json() as TraceListPage
    expect(smaller.traces[0]?.name).toBe(`${label} · Session activity`)
    expect(smaller.hasMore).toBe(true)
  })

  it('sanitizes provider failure details without changing source contents', async () => {
    const { ctx, get } = await composition()
    vi.spyOn(ctx.trajectoryProjection, 'list').mockRejectedValueOnce(new Error('secret launch token and private source content'))
    const response = await get('traces')
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'VIEWER_UNAVAILABLE' })
    expect((await ctx.trajectoryCollector.status()).records).toBe(0)
  })

  it('maps actual provider query quotas and input bounds to sanitized HTTP errors', async () => {
    const { get, append, ctx } = await composition({ maxQueryItems: 1, maxQueryBytes: 1 })
    await append([header(), event(0, 'turn/start', { turn: 1 })])
    for (const action of ['traces?limit=1', 'detail?limit=1&traceId=' + 'a'.repeat(32)]) {
      const response = await get(action)
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'VIEWER_PAGE_TOO_LARGE' })
    }
    expect((await get('traces?limit=2')).status).toBe(400)
    const read = ctx.trajectoryCollector.read.bind(ctx.trajectoryCollector)
    let code = 'COLLECTOR_INPUT'
    // Only fault the viewer's exact read budget, leaving the real projection worker's source polls intact.
    vi.spyOn(ctx.trajectoryCollector, 'read').mockImplementation(query => query.maxBytes === 1048576
      ? Promise.reject(Object.assign(new Error('private provider diagnostic'), { code })) : read(query))
    expect((await get('records')).status).toBe(400)
    code = 'COLLECTOR_QUOTA'
    expect((await get('records')).status).toBe(413)
    vi.spyOn(ctx.trajectoryProjection, 'list').mockRejectedValueOnce('private non-Error rejection')
    expect(await (await get('traces?limit=1')).json()).toEqual({ error: 'VIEWER_UNAVAILABLE' })
    vi.spyOn(ctx.trajectoryProjection, 'list').mockRejectedValueOnce(null)
    expect(await (await get('traces?limit=1')).json()).toEqual({ error: 'VIEWER_UNAVAILABLE' })
  })

  it('keeps an expired read owned until settlement without sending a second response or losing unload drainage', async () => {
    const { ctx, get } = await composition()
    const entered = barrier(); const release = barrier()
    cleanups.push(async () => { release.release() })
    const original = ctx.trajectoryProjection.list.bind(ctx.trajectoryProjection)
    vi.spyOn(ctx.trajectoryProjection, 'list').mockImplementation(async (query) => {
      entered.release(); await release.promise; return original(query)
    })
    // Capture only this route's documented deadline; fire it after the provider enters, not after a wall-clock sleep.
    const timers: (() => void)[] = []
    const setTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (delay === 10000) timers.push(() => { callback(...args) })
      return setTimeout(callback, delay, ...args)
    })
    const pending = get('traces')
    await entered.promise
    expect(timers).toHaveLength(1)
    timers[0]!()
    const expired = await pending
    expect(expired.status).toBe(504)
    expect(await expired.json()).toEqual({ error: 'VIEWER_TIMEOUT' })
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'trajectory-viewer')
    if (entry?.fiber === undefined) throw new Error('viewer fixture did not load')
    let disposed = false
    const disposal = entry.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.release()
    await disposal
    expect(disposed).toBe(true)
    expect((await get('traces')).status).toBe(404)
  })

  it('rejects an unknown action and closes admission even when a caller retains the route object', async () => {
    const { ctx, get } = await composition()
    const http = new ViewerHttp(ctx)
    cleanups.push(() => http.dispose())
    const remove = ctx.webServer.register({ kind: 'exact', path: '/api/trajectory-viewer/unknown', handler: (req, res) => http.handle(req, res) })
    cleanups.push(async () => { remove() })
    expect((await get('unknown')).status).toBe(400)
    await http.dispose()
    expect(await (await get('unknown')).json()).toEqual({ error: 'VIEWER_BUSY' })
  })

  it('bounds concurrent reads and drains an admitted read before removing the provider', async () => {
    const { ctx, get } = await composition()
    const entered = barrier(); const release = barrier()
    cleanups.push(async () => { release.release() })
    const original = ctx.trajectoryProjection.list.bind(ctx.trajectoryProjection)
    let calls = 0
    vi.spyOn(ctx.trajectoryProjection, 'list').mockImplementation(async (query) => {
      calls++; if (calls === 8) entered.release()
      await release.promise
      return original(query)
    })
    const pending = Array.from({ length: 8 }, () => get('traces'))
    await entered.promise
    const busy = await get('status')
    expect(busy.status).toBe(503)
    expect(await busy.json()).toEqual({ error: 'VIEWER_BUSY' })
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'trajectory-viewer')
    if (entry?.fiber === undefined) throw new Error('viewer fixture did not load')
    let disposed = false
    const disposal = entry.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.release()
    expect((await Promise.all(pending)).map(response => response.status)).toEqual(Array.from({ length: 8 }, () => 200))
    await disposal
    // The shared Connection /api prefix remains; only the viewer's exact routes disappear.
    expect((await get('status')).status).toBe(404)
    expect((await get('traces')).status).toBe(404)
    expect((await ctx.trajectoryCollector.status()).records).toBe(0)
    const table: IndexInjection[] = []
    ctx.emit('webserver/index-inject', table)
    expect(table.some(row => row.kind === 'global' && row.name === '__DSH_TRAJECTORY_VIEWER_CONFIG__')).toBe(false)
  })

  it('rolls back partial route registration when a later route collides', async () => {
    const { ctx, get } = await composition()
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'trajectory-viewer')
    if (entry?.fiber === undefined) throw new Error('viewer fixture did not load')
    await entry.fiber.dispose()
    const remove = ctx.webServer.register({ kind: 'exact', path: '/api/trajectory-viewer/detail', handler(_req, res) { res.end('other owner') } })
    cleanups.push(async () => { remove() })
    expect(() => { Viewer.apply(ctx, Viewer.Config()) }).toThrow('duplicate')
    expect((await get('status')).status).toBe(404)
    expect((await get('traces')).status).toBe(404)
    expect(await (await get('detail')).text()).toBe('other owner')
    expect((await get('records')).status).toBe(404)
  })
})
