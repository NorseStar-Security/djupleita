import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import Collector from '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
import Projection, { type Config as ProjectionConfig } from '@deepseek-ai/dsh-experimental-trajectory-projection'
import type { ProjectionId } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'
import * as Atomic from '@deepseek-ai/dsh-atomic-write'
import type { CollectorIdentity, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import * as Traces from '../src/traces.ts'
import { decodeSpans, tracePartialResponse } from './trace-protocol.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'trace exporter fixture cleanup failed')
})

const identity: CollectorIdentity = {
  installationId: brandString<CollectorIdentity['installationId']>('installation'),
  studentId: brandString<CollectorIdentity['studentId']>('student'), cohortId: brandString<CollectorIdentity['cohortId']>('cohort'),
}

function record(sequence: number, type: string, data: object, session = 'session'): TrajectoryRecord {
  const timestamp = 1000 + sequence
  return { sessionId: SessionId(session), sequence, type, timestamp,
    content: JSON.stringify({ seq: sequence, type, time: timestamp, data }) }
}

async function fixture(config: Partial<Traces.Config> = {}, projectionConfig: Partial<ProjectionConfig> = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-traces-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const stateDir = join(directory, 'trace-state')
  const tokenFile = join(directory, 'token')
  await writeFile(tokenFile, 'fixture-traces-token\n', { mode: 0o600 })
  const requests: { bytes: Buffer; authorization: string | undefined; path: string | undefined }[] = []
  const spans: ReturnType<typeof decodeSpans> = []
  const receiver = { status: 200, response: Buffer.alloc(0), hang: false, pauseAt: 0, active: 0 }
  const failures: unknown[] = []
  const pending = new Set<Promise<void>>()
  const server = createServer((req, res) => {
    receiver.active++
    res.once('close', () => { receiver.active-- })
    const operation = (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      requests.push({ bytes, authorization: req.headers.authorization, path: req.url })
      spans.push(...decodeSpans(bytes))
      if (receiver.hang || receiver.pauseAt > 0 && requests.length >= receiver.pauseAt) return
      res.writeHead(receiver.status, { 'content-type': 'application/x-protobuf' })
      res.end(receiver.response)
    })().catch((error: unknown) => { failures.push(error); res.destroy() }).finally(() => { pending.delete(operation) })
    pending.add(operation)
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await Promise.allSettled(pending)
    if (failures.length) throw new AggregateError(failures, 'trace OTLP receiver failed')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('trace receiver listener missing')
  const endpoint = `http://127.0.0.1:${address.port}/v1/traces`
  const checkpoint = async () => JSON.parse(await readFile(join(stateDir, 'traces.json'), 'utf8')) as { completionCursor: number }
  const health = async () => JSON.parse(await readFile(join(stateDir, 'health.json'), 'utf8')) as {
    state: string
    code?: string
    acknowledgedThisRun: number
  }
  let current: Context | undefined
  const onExit = vi.fn<(code: number) => void>()
  const boot = async (overrides: Partial<Traces.Config> = {}, projectionPath = join(directory, 'projection', 'view.sqlite')) => {
    const ctx = new Context()
    ctx.provide('appExit', onExit)
    current = ctx
    ctx.baseUrl = pathToFileURL(directory).href + '/'
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, collector: Collector, projection: Projection, traces: Traces })
    const path = join(directory, 'cordis.yml')
    await writeFile(path, JSON.stringify([
      { name: 'cordis:collector', config: { path: join(directory, 'collector', 'intake.sqlite'), minFreeBytes: 0 } },
      { name: 'cordis:projection', config: { path: projectionPath, minFreeBytes: 0, pollIntervalMs: 10, ...projectionConfig } },
      { id: 'traces', name: 'cordis:traces', config: { endpoint, tokenFile, stateDir, sourceId: 'archive', allowFullContent: true,
        allowInsecureLoopback: true, spansPerPage: 2, pollIntervalMs: 10, retryInitialMs: 10, retryMaxMs: 20, timeoutMs: 1000,
        ...config, ...overrides } },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
    return ctx
  }
  const seed = async (ctx: Context, session = 'session', parent?: string, child?: string) => {
    await ctx.trajectoryCollector.append(identity, { sessionId: SessionId(session), sequence: -1, type: 'session/header', timestamp: 999,
      content: JSON.stringify({ header: { id: session, createdAt: 999, ...parent === undefined ? {} : { parentSession: parent } },
        inheritedEventCount: 0 }) })
    const append = async (sequence: number, type: string, data: object) =>
      ctx.trajectoryCollector.append(identity, record(sequence, type, data, session))
    await append(0, 'turn/start', { turn: 1 })
    await append(1, 'assistant/message', { turn: 1, step: 1, stream: [], message: { role: 'assistant', content: [] } })
    await append(2, 'tool/call', { turn: 1, step: 1, callId: 'call-one', name: 'web_fetch', arguments: '{"url":"https://out-of-scope.invalid/"}' })
    await append(3, 'plugin:network-scope-guard/judge', { turn: 1, step: 1, callId: 'call-one', tool: 'web_fetch', allowed: false, code: 'SCOPE_DENIED' })
    await append(4, 'tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-one', content: [], isError: true }, error: { code: 'SCOPE_DENIED' } })
    if (child !== undefined) await append(5, 'subagent/catalog', { childId: child })
    await append(child === undefined ? 5 : 6, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  return { directory, endpoint, stateDir, tokenFile, requests, spans, receiver, boot, seed, checkpoint, health, onExit,
    stop: async () => { await current?.fiber.dispose() } }
}

describe('optional traces through real Loader, collector, projection, and loopback OTLP', () => {
  it('exports completed turn/model/tool/scope spans with projection IDs and real parent nesting, independent of logs', async () => {
    const f = await fixture()
    const ctx = await f.boot()
    await f.seed(ctx)
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(5)
    expect(f.spans).toHaveLength(5)
    const root = f.spans.find(value => value.attributes['dsh.span.kind'] === 'turn')
    if (root === undefined) throw new Error('completed root span missing')
    expect(root.status.code).toBe(2)
    expect(root.parentSpanId).toBeUndefined()
    expect(new Set(f.spans.map(value => value.traceId))).toEqual(new Set([root.traceId]))
    for (const span of f.spans.filter(value => value !== root)) expect(span.parentSpanId).toBe(root.spanId)
    expect(f.spans.map(value => value.attributes['dsh.span.kind']).sort()).toEqual(['event', 'model', 'scope', 'tool', 'turn'])
    const page = await ctx.trajectoryProjection.readCompleted({ after: 0, limit: 10, maxBytes: 100000 })
    expect(f.spans.map(value => value.spanId)).toEqual(page.spans.map(value => value.spanId))
    expect((await ctx.trajectoryCollector.status()).exportedCursor).toBe(0)
    expect(f.requests.every(value => value.path === '/v1/traces' && value.authorization === 'Bearer fixture-traces-token')).toBe(true)
    await f.seed(ctx, 'child-session', 'session')
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(10)
    expect(f.spans.filter(value => value.attributes['dsh.session.id'] === 'child-session').every(value => value.attributes['dsh.parent_session.id'] === 'session')).toBe(true)
    await f.stop()
    const count = f.requests.length
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    expect(f.requests).toHaveLength(count)
  })

  it('retries stable protobuf span identities through an outage and resumes only acknowledged completions', async () => {
    const f = await fixture()
    f.receiver.status = 503
    let ctx = await f.boot()
    await f.seed(ctx)
    await expect.poll(async () => (await f.health()).state).toBe('retrying')
    expect((await f.checkpoint()).completionCursor).toBe(0)
    const first = f.requests[0]?.bytes
    await f.stop()
    f.receiver.status = 200
    ctx = await f.boot()
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(5)
    expect(f.requests.filter(value => value.bytes.equals(first ?? Buffer.alloc(0))).length).toBeGreaterThanOrEqual(2)
    expect((await ctx.trajectoryCollector.status()).exportedCursor).toBe(0)
  })

  it('does not checkpoint a lost acknowledgement, aborts on unload, and replays the exact span after restart', async () => {
    const f = await fixture()
    f.receiver.hang = true
    await f.seed(await f.boot())
    await expect.poll(() => f.requests.length).toBe(1)
    expect((await f.checkpoint()).completionCursor).toBe(0)
    await f.stop()
    await expect.poll(() => f.receiver.active).toBe(0)
    expect((await f.health()).state).toBe('stopped')
    f.receiver.hang = false
    await f.boot()
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(5)
    expect(f.requests[0]?.bytes).toEqual(f.requests[1]?.bytes)
  })

  it('publishes progress between individual spans before a whole page completes', async () => {
    const f = await fixture({ timeoutMs: 15_000 })
    f.receiver.pauseAt = 2
    await f.seed(await f.boot())
    await expect.poll(() => f.requests.length).toBe(2)
    expect(await f.health()).toMatchObject({ state: 'exporting', acknowledgedThisRun: 1 })
    expect((await f.checkpoint()).completionCursor).toBe(1)
    await f.stop()
    await expect.poll(() => f.receiver.active).toBe(0)
    expect((await f.health()).state).toBe('stopped')
  })

  it('stops on remote partial rejection without automatic retry or advancing the completion checkpoint', async () => {
    const f = await fixture()
    f.receiver.response = Buffer.from(tracePartialResponse(1))
    await f.seed(await f.boot())
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_PARTIAL_REJECTION')
    expect(f.requests).toHaveLength(1)
    expect((await f.checkpoint()).completionCursor).toBe(0)
  })

  it('rejects changed destinations or a replacement projection generation instead of skipping history', async () => {
    const f = await fixture()
    await f.seed(await f.boot())
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(5)
    await f.stop()
    const count = f.requests.length
    await f.boot({ sourceId: 'changed' })
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_TRACE_SOURCE_CHANGED')
    expect(f.requests).toHaveLength(count)
    await f.stop()
    await f.boot({}, join(f.directory, 'replacement', 'view.sqlite'))
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_TRACE_SOURCE_CHANGED')
    expect(f.requests).toHaveLength(count)
  })

  it('preserves recorded parent-catalog association without fabricating a cross-trace parent span', async () => {
    const f = await fixture()
    const ctx = await f.boot()
    await f.seed(ctx, 'parent', undefined, 'child')
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(6)
    await f.seed(ctx, 'child', 'parent')
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(11)
    const parent = f.spans.find(value => value.attributes['dsh.session.id'] === 'parent' && value.attributes['dsh.span.kind'] === 'turn')
    const child = f.spans.find(value => value.attributes['dsh.session.id'] === 'child' && value.attributes['dsh.span.kind'] === 'model')
    expect(parent).toBeDefined()
    expect(child?.attributes['dsh.parent_trace.id']).toBe(parent?.traceId)
    expect(child?.traceId).not.toBe(parent?.traceId)
    expect(child?.links ?? []).toEqual([])
  })

  it.each(['broken', 'ahead'] as const)('stops on a %s checkpoint without delivering or advancing it', async (mode) => {
    const f = await fixture()
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    await f.stop()
    const path = join(f.stateDir, 'traces.json')
    const value = JSON.parse(await readFile(path, 'utf8')) as object
    await writeFile(path, mode === 'broken' ? '{' : JSON.stringify({ ...value, completionCursor: 1 }))
    await f.boot()
    await expect.poll(async () => (await f.health()).code).toBe(mode === 'broken' ? 'TRAJECTORY_TRACE_CHECKPOINT_INVALID' : 'TRAJECTORY_TRACE_SOURCE_CHANGED')
    expect(f.requests).toHaveLength(0)
    expect(f.onExit).toHaveBeenCalledWith(1)
  })

  it('stops dependent export when indexing fails or a complete projection page cannot fit', async () => {
    const failed = await fixture({}, { maxSpans: 1 })
    await failed.seed(await failed.boot())
    await expect.poll(async () => (await failed.health()).code).toBe('TRAJECTORY_PROJECTION_FAILED')
    expect(failed.requests).toHaveLength(0)
    const bounded = await fixture({ pageBytes: 1 })
    await bounded.seed(await bounded.boot())
    await expect.poll(async () => (await bounded.health()).code).toBe('TRAJECTORY_TRACE_EXPORT_FAILED')
    expect(bounded.requests).toHaveLength(0)
    expect((await bounded.checkpoint()).completionCursor).toBe(0)
  })

  it('replays accepted spans when a checkpoint commit fails, without acknowledging collector logs', async () => {
    const f = await fixture()
    const write = Atomic.writeFileAtomic
    let commits = 0
    const fault = vi.spyOn(Atomic, 'writeFileAtomic').mockImplementation(async (path, data, options) => {
      if (path === join(f.stateDir, 'traces.json') && ++commits === 2) throw new Error('private fixture disk fault')
      return write(path, data, options)
    })
    await f.seed(await f.boot())
    await expect.poll(async () => (await f.health()).state).toBe('failed')
    expect((await f.checkpoint()).completionCursor).toBe(0)
    expect(f.requests).toHaveLength(1)
    await f.stop()
    fault.mockRestore()
    const ctx = await f.boot()
    await expect.poll(async () => (await f.checkpoint()).completionCursor).toBe(5)
    expect(f.requests[0]?.bytes).toEqual(f.requests[1]?.bytes)
    expect((await ctx.trajectoryCollector.status()).exportedCursor).toBe(0)
  })

  it('reports an unavailable health file independently and drains cancelled owner-lock waits', async () => {
    const failed = await fixture()
    const write = Atomic.writeFileAtomic
    const fault = vi.spyOn(Atomic, 'writeFileAtomic').mockImplementation(async (path, data, options) => {
      if (path === join(failed.stateDir, 'health.json')) throw new Error('private fixture health fault')
      return write(path, data, options)
    })
    await failed.boot()
    await expect.poll(() => failed.onExit.mock.calls.length).toBe(1)
    expect(failed.requests).toHaveLength(0)
    await failed.stop()
    fault.mockRestore()
    const blocked = await fixture()
    await mkdir(blocked.stateDir)
    await writeFile(join(blocked.stateDir, 'owner.lock'), `${process.pid}\n`)
    await blocked.boot()
    await blocked.stop()
    expect(blocked.onExit).not.toHaveBeenCalled()
    expect(blocked.requests).toHaveLength(0)
    const timed = await fixture({ lockWaitMs: 10 })
    await mkdir(timed.stateDir)
    await writeFile(join(timed.stateDir, 'owner.lock'), `${process.pid}\n`)
    await timed.boot()
    await expect.poll(() => timed.onExit.mock.calls.length).toBe(1)
    expect(timed.requests).toHaveLength(0)
  })

  it('stops if a provider generation changes between its status and completed-page reads', async () => {
    const f = await fixture()
    const ctx = await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    const page = await ctx.trajectoryProjection.readCompleted({ after: 0, limit: 1, maxBytes: 10000 })
    vi.spyOn(ctx.trajectoryProjection, 'readCompleted').mockResolvedValueOnce({ ...page,
      projectionId: brandString<ProjectionId>('replacement-generation') })
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_TRACE_SOURCE_CHANGED')
    expect(f.requests).toHaveLength(0)
    expect((await f.checkpoint()).completionCursor).toBe(0)
  })

  it('rejects missing consent, relative paths, unsafe URLs, incompatible retry budgets, and unavailable credentials before delivery', async () => {
    const f = await fixture()
    const ctx = await f.boot()
    const valid = z.resolve({ endpoint: f.endpoint, tokenFile: f.tokenFile, stateDir: f.stateDir, sourceId: 'archive',
      allowFullContent: true, allowInsecureLoopback: true }, Traces.Config, {})[0] as Traces.Config
    expect(() => z.resolve(Object.assign({}, valid, { tokenFile: 'relative' }), Traces.Config, {})).toThrow('absolute')
    for (const endpoint of ['http://example.invalid/v1/traces', 'https://a:b@example.invalid/v1/traces',
      'https://example.invalid/v1/traces?secret=x', 'https://example.invalid/v1/traces#fragment', 'https://example.invalid/v1/logs']) {
      await expect(Traces.apply(ctx, Object.assign({}, valid, { endpoint }))).rejects.toThrow('HTTPS')
    }
    await expect(Traces.apply(ctx, Object.assign({}, valid, { retryInitialMs: 2, retryMaxMs: 1 }))).rejects.toThrow('budgets')
    await expect(Traces.apply(ctx, Object.assign({}, valid, { tokenFile: join(f.directory, 'missing-token') }))).rejects.toHaveProperty('code', 'ENOENT')
    expect(f.onExit).toHaveBeenCalledTimes(7)
    expect(f.requests).toHaveLength(0)
  })
})
