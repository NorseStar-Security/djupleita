/** Trusted native intake pulls bounded persisted records; research never receives archive write credentials. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-projection'
import type { CollectorIdentity, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type { RuntimeController } from './controller.ts'
import { createHash } from 'node:crypto'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'

const maxBytes = 2 * 1024 * 1024

/**
 * Serve authenticated research persistence reads, with no intake, binary copying, or management capability.
 * @param ctx - research context with its own persistence.
 * @param req - already authenticated request.
 * @param res - response owned until the bounded read settles.
 * @param signal - caller deadline or teardown; in-flight storage reads remain owned until settlement.
 */
export async function researchArchive(ctx: Context, req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
  const send = (status: number, value: unknown): void => {
    if (res.destroyed || res.writableEnded) return
    const content = JSON.stringify(value)
    if (Buffer.byteLength(content) > maxBytes) { send(413, { error: 'Archive page exceeds the response budget' }); return }
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(content)
  }
  if (req.method !== 'GET') { send(405, { error: 'Read only' }); return }
  try {
    const url = new URL(req.url ?? '/', 'http://research.invalid')
    if ([...url.searchParams].some(([key]) => !['sessionId', 'after', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1)) {
      send(400, { error: 'Invalid archive query' }); return
    }
    signal.throwIfAborted()
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined) { send(503, { error: 'Research persistence unavailable' }); return }
    const requested = url.searchParams.get('sessionId')
    if (requested === null) {
      const cursor = url.searchParams.get('cursor') ?? ''
      const sessions = [...await persistence.list()].sort((a, b) => a.header.id.localeCompare(b.header.id))
        .filter(row => row.header.id.localeCompare(cursor) > 0).slice(0, 100).map(row => String(row.header.id))
      send(200, { sessions }); return
    }
    if (requested.length === 0 || requested.length > 256) { send(400, { error: 'Invalid session' }); return }
    const after = url.searchParams.get('after') ?? '-1'
    if (!/^(?:-1|0|[1-9]\d*)$/.test(after) || !Number.isSafeInteger(Number(after))) { send(400, { error: 'Invalid record offset' }); return }
    signal.throwIfAborted()
    const handle = await persistence.open(brandString<SessionId>(requested), 'read')
    const records: TrajectoryRecord[] = []
    let offset = Number(after)
    try {
      if (offset === -1) {
        records.push({ sessionId: handle.header.id, sequence: -1, type: 'session/header', timestamp: handle.header.createdAt,
          content: JSON.stringify({ header: handle.header, inheritedEventCount: handle.inheritedEventCount }) })
        offset = 0
      }
      for (let count = 0; count < 100; count++) {
        signal.throwIfAborted()
        const event = (await handle.read(offset, 1)).events[0]
        if (event === undefined) break
        const record = { sessionId: handle.header.id, sequence: event.seq, type: event.type,
          timestamp: event.time, content: JSON.stringify(event) }
        if (Buffer.byteLength(JSON.stringify({ records: [...records, record], next: event.seq + 1 })) > maxBytes) {
          if (records.length === 0) { send(413, { error: 'Archive record exceeds the page budget' }); return }
          break
        }
        records.push(record); offset = event.seq + 1
      }
    } finally { await handle.close() }
    send(200, { records, next: offset })
  } catch { send(503, { error: 'Research archive unavailable' }) }
}

function record(value: unknown, id: string): TrajectoryRecord {
  if (!isJsonValue(value) || value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid research record')
  const row = value as Record<string, JsonValue>
  if (row.sessionId !== id || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence)
    || row.sequence < -1 || typeof row.type !== 'string' || typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp)
    || typeof row.content !== 'string') throw new Error('Invalid research record')
  return { sessionId: brandString<SessionId>(id), sequence: row.sequence,
    type: row.type, timestamp: row.timestamp, content: row.content }
}

function identity(ctx: Context): CollectorIdentity {
  const entry = ctx.configEditor.configuration().find(row => row.entry.options.id === 'course-trajectory-archive')
  const config: unknown = entry?.entry.fiber?.config
  if (config === null || typeof config !== 'object') throw new Error('Configure the native trajectory archive identity first')
  const installation: unknown = Reflect.get(config, 'installationId')
  const student: unknown = Reflect.get(config, 'studentId')
  const cohort: unknown = Reflect.get(config, 'cohortId')
  if (typeof installation !== 'string' || typeof student !== 'string' || typeof cohort !== 'string') throw new Error('Native trajectory archive identity is unavailable')
  return { installationId: brandString<CollectorIdentity['installationId']>(`protected-${createHash('sha256').update(installation).digest('hex')}`),
    studentId: brandString<CollectorIdentity['studentId']>(student), cohortId: brandString<CollectorIdentity['cohortId']>(cohort) }
}

/**
 * Mount an instructor-owned puller into the existing native collector, with distinct runtime identity and replay-safe offsets.
 * @param ctx - native plugin owner.
 * @param controller - native owner of the separate research authentication.
 * @param pollIntervalMs - validated delay between settled archive polls.
 */
export function mountProtectedArchive(ctx: Context, controller: RuntimeController, pollIntervalMs: number): void {
  ctx.inject(['trajectoryCollector', 'trajectoryProjection', 'configEditor'], (owner) => {
    owner.effect(() => {
      let closed = false, timer: ReturnType<typeof setTimeout> | undefined
      const cancelled = (): boolean => closed
      const offsets = new Map<string, number>()
      let cursor = ''
      const poll = async (): Promise<void> => {
        try {
          if (cancelled()) return
          const runtime = (await controller.view()).runtime
          if (runtime.phase !== 'running') return
          if (runtime.appliedRevision === undefined || runtime.policyHash === undefined || runtime.reviewHash === undefined) throw new Error('Missing isolated deployment identity')
          const trusted = identity(owner)
          const page = await controller.archive(new URLSearchParams({ cursor }))
          if (page === null || typeof page !== 'object' || !('sessions' in page) || !Array.isArray(page.sessions)
            || page.sessions.length > 100 || !page.sessions.every(id => typeof id === 'string' && id.length <= 256)) throw new Error('Invalid research session page')
          const sessions: unknown[] = page.sessions
          for (const id of sessions) {
            if (cancelled()) return
            if (typeof id !== 'string') throw new Error('Invalid research session')
            const result = await controller.archive(new URLSearchParams({ sessionId: id, after: String(offsets.get(id) ?? -1) }))
            if (result === null || typeof result !== 'object' || !('records' in result) || !Array.isArray(result.records)
              || result.records.length > 101) throw new Error('Invalid research record page')
            const records: unknown[] = result.records
            for (const value of records) {
              if (cancelled()) return
              const parsed = record(value, id)
              await owner.trajectoryCollector.append(trusted, parsed)
              offsets.delete(id); offsets.set(id, parsed.sequence + 1)
              if (offsets.size > 10000) {
                const oldest = offsets.keys().next().value
                if (oldest !== undefined) offsets.delete(oldest)
              }
            }
            cursor = id
          }
          if (page.sessions.length < 100) cursor = ''
          if (cancelled()) return
          await controller.renewArchiveLease({ revision: runtime.appliedRevision,
            policyHash: runtime.policyHash, reviewHash: runtime.reviewHash })
          if (!cancelled()) controller.trajectoryError = false
        } catch {
          controller.trajectoryError = true
          try { await controller.stopForArchiveFailure() } catch {
            owner.logger.error('Mandatory trajectory intake could not stop isolated research; gateway admission will remain closed when its native lease expires.')
          }
        } finally { if (!closed) timer = setTimeout(() => { pending = poll() }, pollIntervalMs) }
      }
      let pending = poll()
      return async () => {
        closed = true; clearTimeout(timer); await pending
        try {
          if ((await controller.view()).runtime.phase !== 'running') return
          await controller.stopForArchiveFailure()
        } catch {
          controller.trajectoryError = true
          owner.logger.error('Mandatory trajectory intake was removed before isolated research confirmed stopped; gateway admission will remain closed when its native lease expires.')
        }
      }
    }, 'course runtime: native protected trajectory intake')
  })
}

/**
 * Own authenticated archive reads through deadlines, bounded admission, disconnects and unload drainage.
 * @param ctx - research route owner.
 * @param rejected - existing research authentication; returns true after writing a rejection.
 */
export function mountResearchArchive(ctx: Context, rejected: (req: IncomingMessage, res: ServerResponse) => boolean): void {
  ctx.effect(() => {
    let closed = false
    const pending = new Map<Promise<void>, AbortController>()
    const remove = ctx.webServer.register({ kind: 'exact', path: '/course-runtime/archive', handler: (req, res) => {
      if (rejected(req, res)) return
      if (closed || pending.size >= 8) { res.writeHead(503); res.end(); return }
      const lifetime = new AbortController()
      const timer = setTimeout(() => { lifetime.abort(); if (!res.writableEnded) { res.writeHead(504); res.end() } }, 10000)
      const abort = () => { lifetime.abort() }
      res.once('close', abort)
      const task = researchArchive(ctx, req, res, lifetime.signal).finally(() => {
        clearTimeout(timer); res.off('close', abort); pending.delete(task)
      })
      pending.set(task, lifetime)
      return task
    } })
    return async () => {
      closed = true; remove()
      for (const lifetime of pending.values()) lifetime.abort()
      await Promise.allSettled(pending.keys())
    }
  }, 'course runtime: research persistence inspection')
}
