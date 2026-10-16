import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import z from '@deepseek-ai/schemastery'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import Sqlite from '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
import type { CollectorIdentity } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import LocalAttachments from '@deepseek-ai/dsh-attachment-local'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { CollectorError } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import { SessionArchive } from '../src/archive.ts'
import * as Archive from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'Archive fixture teardown failed')
})

const identity: CollectorIdentity = {
  installationId: brandString<CollectorIdentity['installationId']>('fixture-installation'),
  studentId: brandString<CollectorIdentity['studentId']>('fixture-student'),
  cohortId: brandString<CollectorIdentity['cohortId']>('fixture-cohort'),
}
// Schemastery's public resolve validates unknown input and applies defaults before this narrowed result.
const config = (extra: Partial<Archive.Config> = {}) => z.resolve({ ...identity, ...extra }, Archive.Config, {})[0] as Archive.Config
const signal = () => new AbortController().signal
const header = (id: string, extra: Partial<SessionHeader> = {}): SessionHeader => ({
  version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1000, isSeeded: false, ...extra,
})
const event = (seq: number): SessionEvent => seq % 2 === 0
  ? { type: 'turn/start', seq: SessionSeq(seq), time: 2000 + seq, data: { turn: seq / 2 + 1 } }
  : { type: 'turn/end', seq: SessionSeq(seq), time: 2000 + seq, data: { turn: (seq + 1) / 2, reason: { kind: 'completed' } } }

async function files(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  for (const entry of await readdir(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && /\.jsonl$/u.test(entry.name)) {
      const path = join(entry.parentPath, entry.name)
      result[path] = createHash('sha256').update(await readFile(path)).digest('hex')
    }
  }
  return result
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-trajectory-archive-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Jsonl, { root: join(root, 'sessions'), compression: 'none' })
  await ctx.plugin(Sqlite, Sqlite.Config({ path: join(root, 'collector', 'archive.sqlite') }))
  await ctx.plugin(LocalAttachments, { dshHome: join(root, 'home') })
  const archive = (extra: Partial<Archive.Config> = {}) => new SessionArchive(
    ctx.sessionPersistence, ctx.trajectoryCollector, identity, config(extra), extra.copyAttachments ? ctx.attachments : undefined,
  )
  const records = async () => (await ctx.trajectoryCollector.read({ after: 0, limit: 100, maxBytes: 1_000_000 })).records
  return { root, ctx, archive, records }
}

describe('persisted trajectory archive', () => {
  it('copies full headers and active, inactive, child, and inherited logs without modifying JSONL files', async () => {
    const { root, ctx, archive, records } = await fixture()
    const writer = await ctx.sessionPersistence.create(header('active'))
    cleanups.push(() => writer.close())
    await writer.append([event(0)])
    await writer.flush()
    const inactive = await ctx.sessionPersistence.create(header('inactive'))
    await inactive.append([event(0), event(1)])
    await inactive.close()
    const child = await ctx.sessionPersistence.create(header('child', { parentSession: SessionId('inactive'), origin: 'subagent', delegationDepth: 1, isSeeded: true }), { inheritedEventCount: SessionLogOffset(2) })
    await child.append([event(0), event(1), { type: 'session/end-seed', seq: SessionSeq(2), time: 2002, data: { inherited: true } }, { ...event(2), seq: SessionSeq(3) }])
    await child.close()
    const before = await files(join(root, 'sessions'))
    await archive().scan(signal())
    const stored = await records()
    expect(stored).toHaveLength(10)
    expect(stored.every(row => JSON.stringify(row.identity) === JSON.stringify(identity))).toBe(true)
    const childReader = await ctx.sessionPersistence.open(SessionId('child'), 'read')
    const childContent = JSON.stringify({ header: childReader.header, inheritedEventCount: childReader.inheritedEventCount })
    await childReader.close()
    expect(stored.find(row => row.sessionId === 'child' && row.sequence === -1)).toMatchObject({ type: 'session/header', timestamp: 1000,
      content: childContent })
    expect(stored.find(row => row.sessionId === 'active' && row.sequence === 0)).toMatchObject({ timestamp: 2000, type: 'turn/start', content: JSON.stringify(event(0)) })
    expect(await files(join(root, 'sessions'))).toEqual(before)
    await writer.append([event(1)])
    await writer.flush()
    await archive().scan(signal())
    expect(await records()).toHaveLength(11)
  })

  it('skips unchanged revisions, reads bounded event slices, and safely replays after cursor eviction or restart', async () => {
    const { ctx, archive, records } = await fixture()
    for (const id of ['A', 'b', 'z']) {
      const writer = await ctx.sessionPersistence.create(header(id))
      await writer.append([event(0), event(1)])
      await writer.close()
    }
    const open = vi.spyOn(ctx.sessionPersistence, 'open')
    const worker = archive({ maxSessionsPerScan: 1, eventsPerRead: 1 })
    for (let scan = 0; scan < 9; scan++) await worker.scan(signal())
    expect(await records()).toHaveLength(9)
    expect(open).toHaveBeenCalledTimes(9)
    await worker.scan(signal())
    expect(open).toHaveBeenCalledTimes(9)
    const restarted = archive({ maxCachedSessions: 1 })
    await restarted.scan(signal())
    await restarted.scan(signal())
    expect(await records()).toHaveLength(9)
    expect((await ctx.trajectoryCollector.status()).lastCursor).toBe(9)
  })

  it('reports byte conflicts on changed source replay without overwriting committed evidence', async () => {
    const { ctx, archive, records } = await fixture()
    const writer = await ctx.sessionPersistence.create(header('same'))
    await writer.append([event(0)])
    await writer.close()
    await archive().scan(signal())
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const read = handle.read.bind(handle)
      handle.read = async (...options) => ({ ...await read(...options), events: [{ ...event(0), time: 9999 }] })
      return handle
    })
    await expect(archive().scan(signal())).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    expect((await records())[1]?.content).toBe(JSON.stringify(event(0)))
  })

  it('copies file binaries before event ACK and deduplicates equal bytes under different original names', async () => {
    const { ctx, archive, records } = await fixture()
    const data = Buffer.from('private fixture bytes')
    const first = await ctx.attachments.saveFile({ name: 'one.txt', data })
    const second = await ctx.attachments.saveFile({ name: 'two.txt', data })
    const writer = await ctx.sessionPersistence.create(header('files'))
    const message: SessionEvent = { type: 'user/message', seq: SessionSeq(0), time: 2000, surfaceOp: 'append', data: { id: MessageId('files'), role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment: first }, { type: 'file', attachment: second }] } }
    await writer.append([message])
    await writer.close()
    const order: string[] = []
    const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
    const put = ctx.trajectoryCollector.putArtifact.bind(ctx.trajectoryCollector)
    vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => { order.push(`record:${args[1].sequence}`); return append(...args) })
    vi.spyOn(ctx.trajectoryCollector, 'putArtifact').mockImplementation(async (...args) => { order.push('artifact'); return put(...args) })
    await archive({ copyAttachments: true }).scan(signal())
    expect(order).toEqual(['record:-1', 'artifact', 'artifact', 'record:0'])
    expect((await records())[1]?.content).toBe(JSON.stringify(message))
    const artifactId = brandString<Parameters<typeof ctx.trajectoryCollector.getArtifact>[1]>(first.attachmentId.slice(7))
    const artifact = await ctx.trajectoryCollector.getArtifact(identity.installationId, artifactId)
    expect(artifact?.data).toEqual(new Uint8Array(data))
    expect(artifact?.name).toBe(first.attachmentId.slice(7))
    expect((await ctx.trajectoryCollector.status()).artifacts).toBe(1)
  })

  it('leaves binary copying disabled unless explicitly enabled', async () => {
    const { ctx, archive, records } = await fixture()
    const writer = await ctx.sessionPersistence.create(header('reference-only'))
    const attachment = { attachmentId: AttachmentId('sha256:' + 'f'.repeat(64)), name: 'missing.txt', bytes: 1 }
    await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: 2000, surfaceOp: 'append',
      data: { id: MessageId('missing'), role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment }] } }])
    await writer.close()
    await archive().scan(signal())
    expect(await records()).toHaveLength(2)
    expect((await ctx.trajectoryCollector.status()).artifacts).toBe(0)
    await expect(archive({ copyAttachments: true }).scan(signal())).rejects.toHaveProperty('code', 'ARCHIVE_ATTACHMENT')
  })

  it('drains an in-flight append and closes its read handle before cancellation settles', async () => {
    const { ctx, archive } = await fixture()
    const writer = await ctx.sessionPersistence.create(header('drain'))
    await writer.append([event(0)])
    await writer.close()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
    vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return append(...args)
    })
    const open = ctx.sessionPersistence.open.bind(ctx.sessionPersistence)
    const closed = vi.fn()
    vi.spyOn(ctx.sessionPersistence, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args)
      const close = handle.close.bind(handle)
      handle.close = async () => { await close(); closed() }
      return handle
    })
    const controller = new AbortController()
    const pending = archive().scan(controller.signal)
    await entered.promise
    controller.abort()
    expect(closed).not.toHaveBeenCalled()
    release.resolve(undefined)
    await expect(pending).rejects.toBe(controller.signal.reason)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('loads the actual JSONL, SQLite, and archive configuration through Loader and unloads the poller', async () => {
    const { root, ctx } = await fixture()
    const writer = await ctx.sessionPersistence.create(header('loader'))
    await writer.append([event(0)])
    await writer.close()
    await ctx.fiber.dispose()
    const loaded = new Context()
    cleanups.push(() => loaded.fiber.dispose())
    await loaded.plugin(Loader)
    Object.assign(loaded.loader.builtins, { include: Include, jsonl: Jsonl, sqlite: Sqlite, archive: Archive })
    const file = join(root, 'cordis.yml')
    await writeFile(file, JSON.stringify([
      { name: 'cordis:jsonl', config: { root: join(root, 'sessions'), compression: 'none' } },
      { name: 'cordis:sqlite', config: { path: join(root, 'collector', 'archive.sqlite') } },
      { id: 'archive', name: 'cordis:archive', config: { ...identity, pollIntervalMs: 10 } },
    ]))
    await loaded.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await loaded.loader.await()
    await expect.poll(async () => (await loaded.trajectoryCollector.status()).records).toBe(2)
    const entry = [...loaded.loader.entries()].find(value => value.options.id === 'archive')!
    expect(entry.fiber).toBeDefined()
    await entry.fiber!.dispose()
    const list = vi.spyOn(loaded.sessionPersistence, 'list')
    const next = await loaded.sessionPersistence.create(header('after-dispose'))
    await next.close()
    expect(list).not.toHaveBeenCalled()
    expect((await loaded.trajectoryCollector.status()).records).toBe(2)
    expect('default' in Archive).toBe(false)
    expect((Object.create(Loader.prototype) as Loader).unwrapExports(Archive)).toBe(Archive)
  })

  it('stops visibly on a collector failure without acknowledging or mutating the source event', async () => {
    const { ctx, root } = await fixture()
    const writer = await ctx.sessionPersistence.create(header('failure'))
    await writer.append([event(0)])
    await writer.close()
    const before = await files(join(root, 'sessions'))
    const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
    vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => {
      if (args[1].sequence === 0) throw new CollectorError('COLLECTOR_QUOTA', 'fixture capacity')
      return append(...args)
    })
    const fiber = ctx.plugin(Archive, config())
    await fiber.await()
    const logs = () => ctx.logger.buffer.filter(row => row.type === 'error' && String(row.args[0]).includes('Trajectory archive stopped'))
    await expect.poll(() => logs().length).toBe(1)
    expect(logs()[0]?.args[0]).toContain('COLLECTOR_QUOTA')
    await fiber.dispose()
    expect((await ctx.trajectoryCollector.status()).records).toBe(1)
    expect(await files(join(root, 'sessions'))).toEqual(before)
  })

  it('copies real image bytes before the event and drains its in-flight commit on plugin disposal', async () => {
    const { ctx, records } = await fixture()
    const data = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC',
      'base64',
    )
    const attachment = await ctx.attachments.saveImage({ data, mediaType: 'image/png' })
    const writer = await ctx.sessionPersistence.create(header('image'))
    const message: SessionEvent = { type: 'user/message', seq: SessionSeq(0), time: 2000, surfaceOp: 'append',
      data: { id: MessageId('image'), role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment }] } }
    await writer.append([message])
    await writer.close()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
    const exit = vi.fn()
    ctx.provide('appExit', exit)
    vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => {
      if (args[1].sequence === 0) {
        expect((await ctx.trajectoryCollector.status()).artifacts).toBe(1)
        entered.resolve(undefined)
        await release.promise
      }
      return append(...args)
    })
    const fiber = ctx.plugin(Archive, config({ copyAttachments: true }))
    await fiber.await()
    await entered.promise
    const disposed = vi.fn()
    const disposing = fiber.dispose().then(disposed)
    expect(disposed).not.toHaveBeenCalled()
    release.resolve(undefined)
    await disposing
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    expect((await records())[1]?.content).toBe(JSON.stringify(message))
    const artifactId = brandString<Parameters<typeof ctx.trajectoryCollector.getArtifact>[1]>(attachment.attachmentId.slice(7))
    expect((await ctx.trajectoryCollector.getArtifact(identity.installationId, artifactId))?.data).toEqual(new Uint8Array(data))
  })

  it('refuses binary copying without an attachment provider', () => {
    expect(() => { Archive.apply(new Context(), config({ copyAttachments: true })) }).toThrow('copyAttachments requires')
  })

  it('requests failed process exit on unknown source failure without exposing private diagnostics', async () => {
    const { ctx } = await fixture()
    const exit = vi.fn()
    ctx.provide('appExit', exit)
    vi.spyOn(ctx.sessionPersistence, 'list').mockRejectedValue(new Error('private source diagnostic'))
    const fiber = ctx.plugin(Archive, config())
    await fiber.await()
    await expect.poll(() => exit.mock.calls.length).toBe(1)
    expect(exit).toHaveBeenCalledWith(1)
    const logs = ctx.logger.buffer.filter(row => row.type === 'error')
    expect(logs.some(row => String(row.args[0]).includes('ARCHIVE_SOURCE'))).toBe(true)
    expect(JSON.stringify(logs)).not.toContain('private source diagnostic')
    await fiber.dispose()
  })

  it('stops visibly before ACK when a referenced binary is missing', async () => {
    const { ctx } = await fixture()
    const writer = await ctx.sessionPersistence.create(header('missing-binary'))
    const attachment = { attachmentId: AttachmentId('sha256:' + 'f'.repeat(64)), name: 'missing.txt', bytes: 1 }
    await writer.append([{ type: 'user/message', seq: SessionSeq(0), time: 2000, surfaceOp: 'append',
      data: { id: MessageId('missing'), role: 'user', source: { kind: 'user' }, content: [{ type: 'file', attachment }] } }])
    await writer.close()
    const exit = vi.fn()
    ctx.provide('appExit', exit)
    const fiber = ctx.plugin(Archive, config({ copyAttachments: true }))
    await fiber.await()
    await expect.poll(() => exit.mock.calls.length).toBe(1)
    expect(ctx.logger.buffer.some(row => row.type === 'error' && String(row.args[0]).includes('ARCHIVE_ATTACHMENT'))).toBe(true)
    expect((await ctx.trajectoryCollector.status()).records).toBe(1)
    expect((await ctx.trajectoryCollector.status()).artifacts).toBe(0)
    await fiber.dispose()
  })
})
