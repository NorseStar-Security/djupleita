import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import * as Atomic from '@deepseek-ai/dsh-atomic-write'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as Exporter from '../src/index.ts'
import { digest, TrajectoryEncoder } from '../src/encoding.ts'
import { DeliveryError, deliver, readBoundedFile, readToken } from '../src/transport.ts'
import { cleanups, decode, event, fixture, partialResponse, resolveConfig } from './harness.ts'

afterEach(async () => {
  vi.restoreAllMocks()
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'trajectory fixture cleanup failed')
})

describe('trajectory export through the real Loader and JSONL provider', () => {
  it('copies a complete recorded scope trajectory, including denied calls, without feedback or source changes', async () => {
    const f = await fixture()
    const recording = await readFile(new URL('../../../../snapshots/session/network-scope/session.v4.jsonl', import.meta.url), 'utf8')
    const events = recording.trim().split('\n').slice(1).map((line, seq) => ({
      ...JSON.parse(line) as Omit<SessionEvent, 'seq' | 'time'>, seq: SessionSeq(seq), time: 1000 + seq,
    })) as SessionEvent[]
    await f.seed('recorded-scope', events)
    const sourcePath = join(f.source, '_no-cwd', 'recorded-scope', 'session.v4.jsonl')
    const sourceBytes = await readFile(sourcePath)
    await f.boot()
    await expect.poll(() => f.records.length).toBe(events.length + 1)
    const copied = f.records.slice(1).map(record => JSON.parse(record.body) as { type: string; data: object })
    expect(copied).toEqual(events)
    expect(copied.filter(record => record.type === 'plugin:network-scope-guard/judge')).toMatchObject([
      { data: { allowed: true } }, { data: { allowed: true } }, { data: { allowed: false, code: 'SCOPE_DENIED' } },
    ])
    expect(JSON.parse(f.records[0]!.body)).toMatchObject({ header: { id: 'recorded-scope' }, inheritedEventCount: 0 })
    expect(f.requests.every(request => request.authorization === 'Bearer fixture-write-token' && request.path === '/v1/logs')).toBe(true)
    const handle = await f.writer.sessionPersistence.open((await f.writer.sessionPersistence.list())[0]!.header.id, 'read')
    try { expect((await handle.read()).events).toEqual(events) } finally { await handle.close() }
    expect(await readFile(sourcePath)).toEqual(sourceBytes)
    await expect.poll(async () => (await f.health()).state).toBe('idle')
  })

  it('resumes acknowledged progress after restart and discovers active appends and separate sessions', async () => {
    const f = await fixture({ eventsPerSession: 1 })
    const handle = await f.seed('trajectory', [event(0), event(1)])
    await f.boot()
    await expect.poll(() => f.records.length).toBe(3)
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    await f.stop()
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    expect(f.records).toHaveLength(3)
    await handle.append([event(2)])
    await handle.flush()
    const child = await f.writer.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: SessionId('another'),
      createdAt: 2000, isSeeded: false, origin: 'subagent', parentSession: handle.id, delegationDepth: 1 })
    cleanups.push(() => child.close())
    await child.append([event(0, 'child')])
    await child.flush()
    await expect.poll(() => f.records.length).toBe(6)
    expect(f.records.filter(record => record.attributes['dsh.session.id'] === 'trajectory').map(record => record.attributes['dsh.event.seq'])).toEqual(['-1', '0', '1', '2'])
    expect(JSON.parse(f.records.find(record => record.attributes['dsh.session.id'] === 'another')!.body)).toMatchObject({
      header: { origin: 'subagent', parentSession: 'trajectory', delegationDepth: 1 },
    })
  })

  it('retains history through an outage, retries stable identities, and rereads a rotated token', async () => {
    const f = await fixture()
    await f.seed('trajectory', [event(0)])
    f.state.status = 503
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('retrying')
    expect((await readdir(f.stateDir)).filter(file => /^[a-f0-9]{64}\.json$/.test(file))).toEqual([])
    await writeFile(f.tokenFile, 'rotated-token\n')
    f.state.status = 200
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    expect(f.records[0]!.attributes['dsh.record.id']).toBe(f.records[1]!.attributes['dsh.record.id'])
    expect(f.requests.at(-1)!.authorization).toBe('Bearer rotated-token')
    expect(f.records.at(-1)!.attributes['dsh.event.seq']).toBe('0')
  })

  it.each([401, 403, 413, 500])('stops visibly on permanent HTTP %s without checkpointing', async (status) => {
    const onExit = vi.fn<(code: number) => void>()
    const f = await fixture({}, status === 401 ? onExit : undefined)
    await f.seed()
    f.state.status = status
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('failed')
    expect((await f.health()).code).toBe(`TRAJECTORY_HTTP_${status}`)
    expect(f.requests).toHaveLength(1)
    if (status === 401) expect(onExit).toHaveBeenCalledExactlyOnceWith(1)
    expect((await readdir(f.stateDir)).filter(file => /^[a-f0-9]{64}\.json$/.test(file))).toEqual([])
  })

  it('does not retry a partial rejection or silently truncate a large multibyte event', async () => {
    const f = await fixture({ fragmentBytes: 128 })
    const data = event(0, '安全🔬'.repeat(300))
    await f.seed('trajectory', [data])
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    const parts = f.records.filter(record => record.attributes['dsh.event.seq'] === '0')
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every(record => record.eventName === 'dsh.trajectory.fragment')).toBe(true)
    const restored = Buffer.concat(parts.map(record => Buffer.from(record.body, 'base64'))).toString('utf8')
    expect(JSON.parse(restored)).toEqual(data)
    expect(parts.every(record => record.attributes['dsh.record.sha256'] === digest(restored))).toBe(true)
    await f.stop()
    f.state.response = Buffer.from(partialResponse(1))
    const before = f.requests.length
    await f.seed('rejected')
    await f.boot()
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_PARTIAL_REJECTION')
    expect(f.requests.length - before).toBe(1)
  })

  it('checkpoints a fragmented event only after all parts are acknowledged and replays incomplete parts after restart', async () => {
    const f = await fixture({ fragmentBytes: 128 })
    const data = event(0, 'large-trajectory-'.repeat(100))
    await f.seed('trajectory', [data])
    f.state.callback = () => {
      const current = f.records.at(-1)!
      if (current.attributes['dsh.event.seq'] === '0' && current.attributes['dsh.record.part'] === '1') f.state.hang = true
    }
    await f.boot()
    await expect.poll(() => f.state.hang).toBe(true)
    const checkpoint = join(f.stateDir, `${digest('trajectory')}.json`)
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toHaveProperty('nextSeq', 0)
    const firstPart = f.records.find(record => record.attributes['dsh.event.seq'] === '0')!
    await f.stop()
    f.state.callback = undefined
    f.state.hang = false
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    expect(JSON.parse(await readFile(checkpoint, 'utf8'))).toHaveProperty('nextSeq', 1)
    expect(f.records.filter(record => record.attributes['dsh.record.id'] === firstPart.attributes['dsh.record.id']
      && record.attributes['dsh.record.part'] === '0')).toHaveLength(2)
  })

  it('binds checkpoints to the destination and fails loud on corruption', async () => {
    const f = await fixture()
    await f.seed()
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    await f.stop()
    const count = f.requests.length
    await f.boot({ sourceId: 'different-installation' })
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_DESTINATION_CHANGED')
    expect(f.requests).toHaveLength(count)
    await f.stop()
    await writeFile(join(f.stateDir, `${digest('trajectory')}.json`), '{}')
    await f.boot()
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_CHECKPOINT_INVALID')
  })

  it('aborts an in-flight request on unload and leaves the record unacknowledged', async () => {
    const f = await fixture()
    await f.seed()
    f.state.hang = true
    const arrived = f.arrived()
    await f.boot()
    await arrived
    await f.stop()
    await expect.poll(() => f.state.active).toBe(0)
    expect((await f.health()).state).toBe('stopped')
    expect((await readdir(f.stateDir)).filter(file => /^[a-f0-9]{64}\.json$/.test(file))).toEqual([])
  })

  it.each(['header', 'consistency', 'tail', 'truncated', 'destination'])('refuses %s changes instead of skipping stored events', async (mode) => {
    const f = await fixture()
    await f.seed('trajectory', [event(0)])
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    await f.stop()
    const path = join(f.stateDir, `${digest('trajectory')}.json`)
    const cursor = JSON.parse(await readFile(path, 'utf8')) as { headerHash: string; nextSeq: number; lastHash: string }
    if (mode === 'destination') await rm(join(f.stateDir, 'destination.json'))
    else {
      if (mode === 'header') cursor.headerHash = '0'.repeat(64)
      if (mode === 'consistency') cursor.nextSeq = 0
      if (mode === 'tail') cursor.lastHash = '0'.repeat(64)
      if (mode === 'truncated') cursor.nextSeq = 2
      await writeFile(path, JSON.stringify(cursor))
    }
    const requests = f.requests.length
    await f.boot()
    await expect.poll(async () => (await f.health()).code).toBe(mode === 'destination' ? 'TRAJECTORY_DESTINATION_MISSING' : 'TRAJECTORY_SOURCE_CHANGED')
    expect(f.requests).toHaveLength(requests)
  })

  it('retains stable record identities after an ambiguous lost acknowledgement', async () => {
    const f = await fixture()
    await f.seed()
    f.state.disconnect = true
    const arrived = f.arrived()
    await f.boot()
    await arrived
    await expect.poll(async () => (await f.health()).state).toBe('retrying')
    f.state.disconnect = false
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    expect(new Set(f.records.map(record => record.attributes['dsh.record.id'])).size).toBe(1)
  })

  it('stops after source parsing fails without treating it as a delivery outage', async () => {
    const f = await fixture()
    await f.seed('trajectory', [event(0)])
    const path = join(f.source, '_no-cwd', 'trajectory', 'session.v4.jsonl')
    const header = (await readFile(path, 'utf8')).split('\n')[0]!
    const invalid = { type: 'session/title', data: { title: 3 } }
    const committed = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
    await writeFile(path, `${header}\n${JSON.stringify(invalid)}\n${JSON.stringify(committed)}\n`)
    await f.boot()
    await expect.poll(async () => (await f.health()).code).toBe('TRAJECTORY_EXPORT_FAILED')
    expect(f.requests).toHaveLength(0)
  })

  it('reports checkpoint ownership failure without overwriting another collector health file', async () => {
    const f = await fixture({ lockWaitMs: 20 })
    await mkdir(f.stateDir)
    await writeFile(join(f.stateDir, 'owner.lock'), `${process.pid}\n`)
    const ctx = await f.boot()
    await expect.poll(() => ctx.logger.buffer.some(message => message.args.join(' ').includes('ownership or storage unavailable'))).toBe(true)
    await expect(f.health()).rejects.toHaveProperty('code', 'ENOENT')
  })

  it('replays an acknowledged event after its checkpoint commit fails, without losing source history', async () => {
    const f = await fixture()
    await f.seed('trajectory', [event(0)])
    const path = join(f.stateDir, `${digest('trajectory')}.json`)
    const original = Atomic.writeFileAtomic
    let commits = 0
    const write = vi.spyOn(Atomic, 'writeFileAtomic').mockImplementation(async (target, data, options) => {
      if (target === path && ++commits === 2) throw new Error('fixture checkpoint disk full')
      return original(target, data, options)
    })
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('failed')
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ nextSeq: 0 })
    expect(f.records).toHaveLength(2)
    write.mockRestore()
    await f.stop()
    await f.boot()
    await expect.poll(async () => (await f.health()).state).toBe('idle')
    expect(f.records).toHaveLength(3)
    expect(f.records[1]).toEqual(f.records[2])
    const source = await f.writer.sessionPersistence.open(SessionId('trajectory'), 'read')
    try { expect((await source.read()).events).toEqual([event(0)]) } finally { await source.close() }
  })

  it('drains a cancelled checkpoint-lock wait without a spurious export error', async () => {
    const f = await fixture()
    await mkdir(f.stateDir)
    await writeFile(join(f.stateDir, 'owner.lock'), `${process.pid}\n`)
    const ctx = await f.boot()
    await f.stop()
    expect(ctx.logger.buffer.some(message => message.args.join(' ').includes('ownership or storage unavailable'))).toBe(false)
  })

  it('reports health-write failure through independent console diagnostics and sends nothing', async () => {
    const onExit = vi.fn<(code: number) => void>()
    const f = await fixture({}, onExit)
    await f.seed()
    const original = Atomic.writeFileAtomic
    vi.spyOn(Atomic, 'writeFileAtomic').mockImplementation(async (path, data, options) => {
      if (path === join(f.stateDir, 'health.json')) throw new Error('fixture disk unavailable')
      return original(path, data, options)
    })
    const ctx = await f.boot()
    await expect.poll(() => ctx.logger.buffer.some(message => message.args.join(' ').includes('ownership or storage unavailable'))).toBe(true)
    expect(f.requests).toHaveLength(0)
    expect(onExit).toHaveBeenCalledExactlyOnceWith(1)
  })

  it.each([false, true])('reports a worker finalization failure without an unhandled rejection (host exit: %s)', async (hostExit) => {
    const onExit = vi.fn<(code: number) => void>()
    const f = await fixture({}, hostExit ? onExit : undefined)
    const close = vi.spyOn(TrajectoryEncoder.prototype, 'close').mockRejectedValueOnce(new Error('fixture shutdown failure'))
    const ctx = await f.boot()
    await f.stop()
    expect(ctx.logger.buffer.some(message => message.args.join(' ').includes('failed to finalize'))).toBe(true)
    if (hostExit) expect(onExit).toHaveBeenCalledExactlyOnceWith(1)
    close.mockRestore()
  })
})

describe('wire and credential limits', () => {
  it('requires explicit full-content consent, HTTPS, absolute paths, and compatible budgets', async () => {
    expect('default' in Exporter).toBe(false)
    expect(() => resolveConfig({})).toThrow()
    expect(() => resolveConfig({ tokenFile: 'relative' })).toThrow()
    const f = await fixture()
    expect(() => resolveConfig({ endpoint: f.endpoint, tokenFile: 'relative', stateDir: f.stateDir, sourceId: 'fixture', allowFullContent: true })).toThrow('absolute')
    const ctx = await f.boot()
    const valid = resolveConfig({ endpoint: f.endpoint, tokenFile: f.tokenFile, stateDir: f.stateDir, sourceId: 'fixture', allowFullContent: true, allowInsecureLoopback: true })
    await expect(Exporter.apply(ctx, Object.assign({}, valid, { endpoint: 'http://example.com/v1/logs' }))).rejects.toThrow('HTTPS')
    const onExit = vi.fn<(code: number) => void>()
    ctx.provide('appExit', onExit)
    for (const endpoint of ['http://example.com/v1/logs', 'https://a:b@example.com/v1/logs', 'https://example.com/v1/logs?secret=x', 'https://example.com/']) {
      await expect(Exporter.apply(ctx, Object.assign({}, valid, { endpoint }))).rejects.toThrow('HTTPS')
    }
    await expect(Exporter.apply(ctx, Object.assign({}, valid, { retryInitialMs: 2, retryMaxMs: 1 }))).rejects.toThrow('budgets')
    await expect(Exporter.apply(ctx, Object.assign({}, valid, { maxRequestBytes: 1024 }))).rejects.toThrow('budgets')
    expect(onExit).toHaveBeenCalledTimes(6)
    await writeFile(f.tokenFile, 'bad\ntoken')
    await expect(readToken(f.tokenFile)).rejects.toHaveProperty('code', 'TRAJECTORY_TOKEN_INVALID')
    await expect(readBoundedFile(f.tokenFile, 2)).rejects.toHaveProperty('code', 'TRAJECTORY_FILE_TOO_LARGE')
  })

  it('bounds encoded requests without clipping their body', async () => {
    const encoder = new TrajectoryEncoder()
    try {
      const identity = { sourceId: 'fixture', sessionId: 'fixture', sequence: 0, type: 'test', timestamp: 1000 }
      const value = JSON.stringify({ full: 'x'.repeat(500) })
      expect(() => [...encoder.encode(value, identity, 1000, 100)]).toThrow('TRAJECTORY_REQUEST_TOO_LARGE')
      expect(decode([...encoder.encode(value, identity, 1000, 2000)][0]!)[0]!.body).toBe(value)
    } finally { await encoder.close() }
  })

  it.each(['oversize', 'malformed', 'encoding', 'redirect', 'timeout', 'disconnect'])('handles %s without accepting delivery', async (mode) => {
    const f = await fixture()
    f.state.response = mode === 'oversize' ? Buffer.alloc(33) : mode === 'malformed' ? Buffer.from([255]) : mode === 'encoding' ? Buffer.from('{}') : Buffer.alloc(0)
    if (mode === 'encoding') f.state.contentType = 'application/json'
    if (mode === 'redirect') { f.state.status = 307; f.state.redirect = `${f.endpoint}?unexpected=1` }
    if (mode === 'timeout') f.state.hang = true
    if (mode === 'disconnect') f.state.disconnect = true
    const encoder = new TrajectoryEncoder()
    const payload = [...encoder.encode('{}', { sourceId: 's', sessionId: 's', sequence: 0, type: 'test', timestamp: 1 }, 100, 10000)][0]!
    try {
      await expect(deliver({ endpoint: f.endpoint, tokenFile: f.tokenFile, timeoutMs: 200, maxResponseBytes: 32 }, payload, new AbortController().signal)).rejects.toThrow('TRAJECTORY_')
      expect(f.requests).toHaveLength(1)
      await expect.poll(() => f.state.active).toBe(0)
    } finally { await encoder.close() }
  })

  it.each(['2', 'date', 'invalid'])('parses Retry-After %s on an unacknowledged response', async (retry) => {
    const f = await fixture()
    f.state.status = 429
    f.state.retryAfter = retry === 'date' ? new Date(Date.now() + 120_000).toUTCString() : retry
    const error = await deliver({ endpoint: f.endpoint, tokenFile: f.tokenFile, timeoutMs: 1000, maxResponseBytes: 1024 },
      new Uint8Array(), new AbortController().signal).catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(DeliveryError)
    if (!(error instanceof DeliveryError)) throw new Error('expected a delivery error')
    expect(error.retryable).toBe(true)
    if (retry === 'date') expect(error.retryAfterMs).toBeGreaterThan(100_000)
    else expect(error.retryAfterMs).toBe(retry === '2' ? 2000 : 0)
  })

  it('accepts an empty success response even when fetch exposes no body stream', async () => {
    const f = await fixture()
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 200 }))
    await expect(deliver({ endpoint: f.endpoint, tokenFile: f.tokenFile, timeoutMs: 1000, maxResponseBytes: 1024 },
      new Uint8Array(), new AbortController().signal)).resolves.toBeUndefined()
  })
})
