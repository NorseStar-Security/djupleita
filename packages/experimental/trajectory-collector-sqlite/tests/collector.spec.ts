import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CohortId, CollectorIdentity, CollectorQuery, InstallationId, StudentId, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import SqliteTrajectoryCollector, { type Config } from '../src/index.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const identity: CollectorIdentity = {
  installationId: brandString<InstallationId>('installation'), studentId: brandString<StudentId>('student'), cohortId: brandString<CohortId>('cohort'),
}
const another: CollectorIdentity = {
  installationId: brandString<InstallationId>('another'), studentId: brandString<StudentId>('other'), cohortId: brandString<CohortId>('other-course'),
}
const query: CollectorQuery = { after: 0, limit: 128, maxBytes: 4 * 1024 * 1024 }
const sessionId = SessionId('session')
function header(id = sessionId): TrajectoryRecord { return { sessionId: id, sequence: -1, type: 'session/header', timestamp: 1, content: JSON.stringify({ header: { id, createdAt: 1, version: 4 }, inheritedEventCount: 0 }) } }
function event(sequence = 0, id = sessionId, data = 'complete content'): TrajectoryRecord { return { sessionId: id, sequence, type: 'user/message', timestamp: sequence + 2, content: JSON.stringify({ seq: sequence, type: 'user/message', time: sequence + 2, data }) } }
function artifact(data = Buffer.from('binary\0content'), name = 'evidence.bin') { return { data, name, sha256: createHash('sha256').update(data).digest('hex') } }

async function directory() { const root = await mkdtemp(join(tmpdir(), 'dsh-collector-')); roots.push(root); return root }
async function boot(config: Partial<Config> = {}, root?: string) {
  root ??= await directory()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, collector: SqliteTrajectoryCollector })
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([{ name: 'cordis:collector', config: { path: join(root, 'collector.sqlite'), ...config } }]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  return { ctx, collector: ctx.trajectoryCollector, root }
}

describe('durable collector through the real Cordis Loader', () => {
  it('commits full content with trusted identity and deduplicates after a restart', async () => {
    const { collector, ctx, root } = await boot()
    const receipt = await collector.append(identity, header())
    const first = await collector.append(identity, event())
    expect(first.duplicate).toBe(false)
    expect(await collector.append(identity, event())).toEqual({ ...first, duplicate: true })
    const page = await collector.read(query)
    expect(page.records.map(value => value.content)).toEqual([header().content, event().content])
    expect(page.records[0]).toMatchObject({ id: receipt.id, cursor: 1, identity })
    await ctx.fiber.dispose()
    await expect(collector.status()).rejects.toHaveProperty('code', 'COLLECTOR_UNAVAILABLE')
    const reopened = await boot({}, root)
    expect(await reopened.collector.append(identity, event())).toEqual({ ...first, duplicate: true })
    expect(await reopened.collector.read(query)).toEqual(page)
    expect(await reopened.collector.status()).toMatchObject({ records: 2, lastCursor: 2, exportedCursor: 0, exportDestination: null })
  })

  it('rejects changed identity, content, or envelope without changing committed evidence', async () => {
    const { collector } = await boot()
    await collector.append(identity, header())
    await collector.append(identity, event())
    for (const record of [event(0, sessionId, 'different'), { ...event(), timestamp: 8, content: JSON.stringify({ ...JSON.parse(event().content), time: 8 }) }]) await expect(collector.append(identity, record)).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await expect(collector.append({ ...identity, studentId: another.studentId }, event())).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await expect(collector.append({ ...identity, cohortId: another.cohortId }, event())).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    expect((await collector.read(query)).records[1]?.content).toBe(event().content)
  })

  it('requires a header and contiguous events independently for each installation/session', async () => {
    const { collector } = await boot()
    await expect(collector.append(identity, event())).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await collector.append(identity, header())
    await expect(collector.append(identity, event(1))).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await expect(collector.append(another, event())).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await collector.append(another, header())
    await collector.append(another, event())
    await collector.append(identity, event())
    expect((await collector.status()).lastCursor).toBe(4)
  })

  it.each([
    { ...header(), content: '{"secret":' }, { ...header(), content: '[]' }, { ...header(), content: 'null' },
    { ...header(), content: '{}' }, { ...header(), type: 'user/message' },
    { ...header(), timestamp: 0 }, { ...header(), sessionId: SessionId('different') },
    { ...header(), content: JSON.stringify({ header: { id: sessionId, createdAt: 1 }, inheritedEventCount: -1 }) },
    { ...event(), type: 'session/header' }, { ...event(), content: '{}' },
    { ...event(), sequence: -2 }, { ...event(), sequence: 0.5 }, { ...event(), timestamp: Infinity },
    { ...event(), sessionId: SessionId('') }, { ...event(), type: '' },
  ])('rejects incomplete or inconsistent records without retaining uploaded bytes: %j', async (record) => {
    const { collector } = await boot()
    await expect(collector.append(identity, record)).rejects.toHaveProperty('code', 'COLLECTOR_INPUT')
    expect(await collector.status()).toMatchObject({ records: 0, lastCursor: 0 })
  })

  it('enforces record, live-content, envelope, filesystem-free, and installation quotas atomically', async () => {
    for (const config of [{ maxRecords: 1 }, { maxContentBytes: Buffer.byteLength(header().content) + 1 }]) {
      const { collector } = await boot(config)
      await collector.append(identity, header())
      await expect(collector.append(identity, event())).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
      expect((await collector.status()).records).toBe(1)
      expect((await collector.append(identity, header())).duplicate).toBe(true)
    }
    for (const config of [{ maxRecordBytes: 1 }, { minFreeBytes: Number.MAX_SAFE_INTEGER }, { maxDatabaseBytes: 65536 }]) {
      const { collector } = await boot(config)
      await expect(collector.append(identity, header())).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
      expect((await collector.status()).records).toBe(0)
    }
    const { collector } = await boot({ maxInstallations: 1 })
    await collector.append(identity, header())
    await expect(collector.append(another, header())).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
    await expect(collector.revoke(another.installationId)).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
    expect(await collector.isRevoked(another.installationId)).toBe(false)
  })

  it('persists revocation before or after first upload and retains readable evidence', async () => {
    const { collector, ctx, root } = await boot()
    await collector.append(identity, header())
    await collector.revoke(identity.installationId)
    await collector.revoke(another.installationId)
    await ctx.fiber.dispose()
    const reopened = (await boot({}, root)).collector
    for (const who of [identity, another]) {
      expect(await reopened.isRevoked(who.installationId)).toBe(true)
      await expect(reopened.append(who, header())).rejects.toHaveProperty('code', 'COLLECTOR_REVOKED')
      await expect(reopened.putArtifact(who, artifact())).rejects.toHaveProperty('code', 'COLLECTOR_REVOKED')
    }
    expect(await reopened.isRevoked(brandString<InstallationId>('absent'))).toBe(false)
    expect((await reopened.read(query)).records).toHaveLength(1)
    expect((await reopened.status()).revokedInstallations).toBe(2)
  })

  it('stores SHA-checked bounded artifacts independently by installation', async () => {
    const { collector, ctx, root } = await boot()
    const value = artifact()
    const id = await collector.putArtifact(identity, value)
    expect(await collector.putArtifact(identity, value)).toBe(id)
    expect(await collector.getArtifact(another.installationId, id)).toBeUndefined()
    await expect(collector.putArtifact(identity, { ...value, name: 'changed' })).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    for (const bad of [{ ...value, sha256: 'bad' }, { ...value, sha256: '0'.repeat(64) }, { ...value, name: 'bad\nname' }, { ...value, name: '' }, { ...value, name: 'x'.repeat(257) }]) await expect(collector.putArtifact(identity, bad)).rejects.toHaveProperty('code', 'COLLECTOR_INPUT')
    await ctx.fiber.dispose()
    const reopened = (await boot({}, root)).collector
    const stored = await reopened.getArtifact(identity.installationId, id)
    expect(stored).toMatchObject({ identity, id, name: value.name, sha256: value.sha256 })
    expect(Buffer.from(stored?.data ?? [])).toEqual(value.data)
    stored?.data.fill(0)
    expect(Buffer.from((await reopened.getArtifact(identity.installationId, id))?.data ?? [])).toEqual(value.data)
    expect((await reopened.status()).artifacts).toBe(1)
  })

  it('bounds artifact bytes, live-content bytes and count without committing partial blobs', async () => {
    for (const config of [{ maxArtifactBytes: 1 }, { maxContentBytes: 1 }]) {
      const { collector } = await boot(config)
      await expect(collector.putArtifact(identity, artifact())).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
      expect((await collector.status()).artifacts).toBe(0)
    }
    const { collector } = await boot({ maxArtifacts: 1 })
    await collector.putArtifact(identity, artifact())
    await expect(collector.putArtifact(identity, artifact(Buffer.from('second')))).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
    expect((await collector.status()).artifacts).toBe(1)
  })

  it('paginates by stable exclusive cursors with exact parameterized filters and complete byte budgets', async () => {
    const { collector } = await boot()
    await collector.append(identity, header())
    await collector.append(another, header(SessionId('second')))
    await collector.append(identity, event())
    const all = await collector.read(query)
    const one = await collector.read({ ...query, limit: 1 })
    expect(one).toMatchObject({ nextCursor: 1, hasMore: true })
    expect((await collector.read({ ...query, after: one.nextCursor })).records.map(value => value.cursor)).toEqual([2, 3])
    const bytes = Buffer.byteLength(JSON.stringify(one))
    expect(await collector.read({ ...query, maxBytes: bytes })).toEqual(one)
    await expect(collector.read({ ...query, maxBytes: bytes - 1 })).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
    const filtered = await collector.read({
      ...query, installationId: identity.installationId, studentId: identity.studentId, cohortId: identity.cohortId, sessionId,
    })
    expect(filtered.records.map(value => value.cursor)).toEqual([1, 3])
    expect((await collector.read({ ...query, sessionId: SessionId("' OR 1=1 --") })).records).toEqual([])
    expect(all.records).toHaveLength(3)
    for (const invalid of [{ after: -1 }, { limit: 0 }, { limit: 129 }, { maxBytes: 0 }, { maxBytes: query.maxBytes + 1 }]) await expect(collector.read({ ...query, ...invalid })).rejects.toHaveProperty('code', 'COLLECTOR_INPUT')
    await expect(collector.read({ ...query, after: 100, maxBytes: 1 })).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
  })

  it('binds one monotonic export destination and prunes only its acknowledged old prefix', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { collector, ctx, root } = await boot()
    vi.setSystemTime(100)
    await collector.append(identity, header())
    vi.setSystemTime(200)
    await collector.append(identity, event())
    vi.setSystemTime(300)
    await collector.append(identity, event(1))
    await collector.markExported('primary', 0)
    await expect(collector.markExported('other', 0)).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await expect(collector.markExported('primary', 4)).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await expect(collector.markExported('', 0)).rejects.toHaveProperty('code', 'COLLECTOR_INPUT')
    await collector.markExported('primary', 2)
    await expect(collector.markExported('primary', 1)).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await expect(collector.pruneExported('other', 1000)).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await expect(collector.pruneExported('primary', NaN)).rejects.toHaveProperty('code', 'COLLECTOR_INPUT')
    expect(await collector.pruneExported('primary', 250)).toBe(1)
    expect((await collector.read(query)).records.map(value => value.sequence)).toEqual([-1, 1])
    await ctx.fiber.dispose()
    const reopened = (await boot({}, root)).collector
    expect(await reopened.status()).toMatchObject({ exportedCursor: 2, exportDestination: 'primary', lastCursor: 3 })
    expect((await reopened.append(identity, event())).duplicate).toBe(true)
    await expect(reopened.append(identity, event(0, sessionId, 'changed after prune'))).rejects.toHaveProperty('code', 'COLLECTOR_CONFLICT')
    await reopened.markExported('primary', 3)
    expect(await reopened.pruneExported('primary', 250)).toBe(0)
    expect(await reopened.pruneExported('primary', 350)).toBe(1)
    await reopened.append(identity, event(2))
    expect((await reopened.read(query)).records.map(value => value.cursor)).toEqual([1, 4])
  })

  it('keeps tombstone count quotas after pruning and does not delete artifacts', async () => {
    const { collector } = await boot({ maxRecords: 2 })
    await collector.append(identity, header())
    await collector.append(identity, event())
    const id = await collector.putArtifact(identity, artifact())
    await collector.markExported('primary', 2)
    await collector.pruneExported('primary', Date.now() + 1)
    await expect(collector.append(identity, event(1))).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
    expect(await collector.getArtifact(identity.installationId, id)).toBeDefined()
    expect((await collector.append(identity, event())).duplicate).toBe(true)
  })

  it('reserves database-page WAL headroom before pruning and preserves evidence when capacity is insufficient', async () => {
    const { collector, ctx, root } = await boot()
    await collector.append(identity, header())
    await collector.append(identity, event())
    await collector.markExported('primary', 2)
    await ctx.fiber.dispose()
    const reopened = (await boot({ maxDatabaseBytes: 131072 }, root)).collector
    const before = await reopened.read(query)
    await expect(reopened.pruneExported('primary', Date.now() + 1)).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
    expect(await reopened.read(query)).toEqual(before)
    expect((await reopened.status()).exportedCursor).toBe(2)
    expect((await reopened.append(identity, event())).duplicate).toBe(true)
    expect(await reopened.pruneExported('primary', 0)).toBe(0)
  })

  it.skipIf(process.platform === 'win32')('creates private durable files and rejects permissive or linked database entries', async () => {
    const { root } = await boot()
    expect((await stat(join(root, 'collector.sqlite'))).mode & 0o777).toBe(0o600)
    expect((await stat(root)).mode & 0o777).toBe(0o700)
    const unsafe = await directory()
    await chmod(unsafe, 0o755)
    expect(() => new SqliteTrajectoryCollector(new Context(), SqliteTrajectoryCollector.Config({ path: join(unsafe, 'bad.db') }))).toThrow('owner-only')
    const linked = await directory()
    await symlink(join(root, 'collector.sqlite'), join(linked, 'alias.db'))
    expect(() => new SqliteTrajectoryCollector(new Context(), SqliteTrajectoryCollector.Config({ path: join(linked, 'alias.db') }))).toThrow('owner-only')
  })

  it('refuses foreign databases and reports unavailable storage without resetting evidence', async () => {
    const root = await directory()
    const path = join(root, 'foreign.db')
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE evidence (value TEXT); INSERT INTO evidence VALUES(\'preserve\')')
    db.close()
    await chmod(path, 0o600)
    const before = await readFile(path)
    expect(() => new SqliteTrajectoryCollector(new Context(), SqliteTrajectoryCollector.Config({ path }))).toThrow('foreign')
    expect(await readFile(path)).toEqual(before)
    const file = join(root, 'not-a-directory')
    await writeFile(file, 'preserve')
    expect(() => new SqliteTrajectoryCollector(new Context(), SqliteTrajectoryCollector.Config({ path: join(file, 'db') }))).toThrow('COLLECTOR_STORAGE')
    expect(() => SqliteTrajectoryCollector.Config({ path: 'relative.sqlite' })).toThrow('absolute')
  })

  it('stops intake after a real SQLite locking failure without acknowledging or losing evidence', async () => {
    const { collector, root } = await boot({ busyTimeoutMs: 0 })
    await collector.append(identity, header())
    const competing = new DatabaseSync(join(root, 'collector.sqlite'))
    try {
      competing.exec('BEGIN IMMEDIATE')
      await expect(collector.append(identity, event())).rejects.toHaveProperty('code', 'COLLECTOR_STORAGE')
      await expect(collector.status()).rejects.toHaveProperty('code', 'COLLECTOR_UNAVAILABLE')
      competing.exec('ROLLBACK')
    } finally { competing.close() }
    const reopened = (await boot({}, root)).collector
    expect((await reopened.read(query)).records).toHaveLength(1)
    expect((await reopened.append(identity, event())).duplicate).toBe(false)
  })

  it('refuses numeric exhaustion from persisted sequence or cursor state', async () => {
    for (const column of ['cursor', 'sequence']) {
      const { collector, root } = await boot()
      await collector.append(identity, header())
      const editor = new DatabaseSync(join(root, 'collector.sqlite'))
      try {
        editor.exec(column === 'cursor' ? `UPDATE collector_state SET last_cursor=${Number.MAX_SAFE_INTEGER}` : `UPDATE sessions SET next_sequence=${Number.MAX_SAFE_INTEGER}`)
      } finally { editor.close() }
      await expect(collector.append(identity, event(column === 'cursor' ? 0 : Number.MAX_SAFE_INTEGER))).rejects.toHaveProperty('code', 'COLLECTOR_QUOTA')
    }
  })

  it('handles absent SQLite sidecars and stops after unexpected filesystem inspection failure', async () => {
    const { collector, root } = await boot()
    const original = fs.statSync(join(root, 'collector.sqlite'))
    const inspection = vi.spyOn(fs, 'statSync')
    inspection.mockImplementationOnce(() => original).mockImplementationOnce(() => { throw Object.assign(new Error('sidecar absent'), { code: 'ENOENT' }) })
    syncBuiltinESMExports()
    await collector.append(identity, header())
    inspection.mockImplementationOnce(() => original).mockImplementationOnce(() => { throw Object.assign(new Error('inspection denied'), { code: 'EACCES' }) })
    await expect(collector.append(identity, event())).rejects.toHaveProperty('code', 'COLLECTOR_STORAGE')
    await expect(collector.status()).rejects.toHaveProperty('code', 'COLLECTOR_UNAVAILABLE')
  })

  it.skipIf(process.platform === 'win32')('reports database creation failure in an unwritable private directory', async () => {
    const root = await directory()
    await chmod(root, 0o500)
    try {
      expect(() => new SqliteTrajectoryCollector(new Context(), SqliteTrajectoryCollector.Config({ path: join(root, 'denied.db') }))).toThrow('COLLECTOR_STORAGE')
    } finally { await chmod(root, 0o700) }
  })
})
