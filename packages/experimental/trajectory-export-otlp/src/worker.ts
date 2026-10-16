/** Opt-in instructor-side consumer of persisted trajectories; never a research-tool capability. */
import { mkdir, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import z from '@deepseek-ai/schemastery'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { TrajectoryCollector } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import { TrajectoryEncoder, digest, type RecordIdentity } from './encoding.ts'
import { DeliveryError, deliver, readBoundedFile, readToken } from './transport.ts'

/** Explicit full-content export authorization, source identity, and delivery budgets. */
export interface Config {
  /** Maximum complete content bytes in one collector page; an oversized record stops export. */
  collectorBatchBytes: number
  /** Full OTLP HTTP logs URL, including /v1/logs. HTTPS is required outside test loopback. */
  endpoint: string
  /** Absolute private token file; reread for every request to support rotation. */
  tokenFile: string
  /** Absolute instructor-owned checkpoint directory, not the source session directory. */
  stateDir: string
  /** Instructor-assigned unique installation/archive identity, never an authenticated student claim. */
  sourceId: string
  /** Required acknowledgement that all persisted content, including sensitive data, leaves this machine. */
  allowFullContent: true
  /** Permit plaintext HTTP only to literal loopback for local protocol tests. */
  allowInsecureLoopback: boolean
  /** Delay after a complete scan, in milliseconds. */
  pollIntervalMs: number
  /** Maximum new events exported from each session in a scan. */
  eventsPerSession: number
  /** Raw UTF-8 bytes per fragment; large events are split without losing bytes. */
  fragmentBytes: number
  /** Maximum encoded protobuf request bytes; an excess stops export without advancing. */
  maxRequestBytes: number
  /** Maximum response body bytes. */
  maxResponseBytes: number
  /** Complete request/response deadline in milliseconds. */
  timeoutMs: number
  /** Initial exponential retry delay with jitter. */
  retryInitialMs: number
  /** Maximum exponential retry delay; a larger server Retry-After is still honored. */
  retryMaxMs: number
  /** Maximum wait for a same-host checkpoint owner; cross-host shared state is unsupported. */
  lockWaitMs: number
}

const absolutePath = z.transform(z.string().required(), (value) => {
  if (!isAbsolute(value)) throw new Error('trajectory paths must be absolute')
  return value
})
const milliseconds = () => z.natural().min(1).max(2_147_483_647)

/** Loader configuration; mounting the plugin requires an explicit content-export acknowledgement. */
export const Config: z<Config> = z.object({
  collectorBatchBytes: z.natural().min(1).max(128 * 1024 * 1024).default(4 * 1024 * 1024),
  endpoint: z.string().required(), tokenFile: absolutePath, stateDir: absolutePath,
  sourceId: z.string().min(1).max(256).required(), allowFullContent: z.const(true).required(),
  allowInsecureLoopback: z.boolean().default(false),
  pollIntervalMs: milliseconds().default(1000), eventsPerSession: z.natural().min(1).max(4096).default(128),
  fragmentBytes: z.natural().min(1).max(256 * 1024).default(64 * 1024),
  maxRequestBytes: z.natural().min(1024).max(4 * 1024 * 1024).default(256 * 1024),
  maxResponseBytes: z.natural().min(1).max(1024 * 1024).default(64 * 1024),
  timeoutMs: milliseconds().default(15_000), retryInitialMs: milliseconds().default(1000),
  retryMaxMs: milliseconds().default(60_000), lockWaitMs: milliseconds().default(2000),
})

const Checkpoint = z.object({
  schema: z.const(1).required(), sessionId: z.string().required(), headerHash: z.string().pattern(/^[a-f0-9]{64}$/).required(),
  nextSeq: z.natural().max(Number.MAX_SAFE_INTEGER).required(), lastHash: z.string().pattern(/^([a-f0-9]{64})?$/).required(),
})
interface Cursor { schema: 1; sessionId: string; headerHash: string; nextSeq: number; lastHash: string }
type HealthState = 'starting' | 'exporting' | 'idle' | 'retrying' | 'failed' | 'stopped'

/** One lifecycle-owned worker; successful HTTP acknowledgements are its only checkpoint authority. */
class ExportWorker {
  private readonly encoder = new TrajectoryEncoder()
  private readonly revisions = new Map<SessionId, SessionPersistenceRevision>()
  private readonly healthPath: string
  private acknowledged = 0

  constructor(private readonly ctx: Context, private readonly config: Config, private readonly signal: AbortSignal,
    private readonly onFailure: () => void, private readonly source: 'persistence' | 'collector') {
    this.healthPath = join(config.stateDir, 'health.json')
  }

  private async health(state: HealthState, code?: string): Promise<void> {
    await writeFileAtomic(this.healthPath, JSON.stringify({ schema: 1, state, code, updatedAt: Date.now(),
      acknowledgedThisRun: this.acknowledged, sourceId: this.config.sourceId }), { mode: 0o600, dirMode: 0o700 })
  }

  private async bindDestination(): Promise<void> {
    const path = join(this.config.stateDir, 'destination.json')
    const identity = JSON.stringify({ schema: 1, endpoint: this.config.endpoint, sourceId: this.config.sourceId,
      fragmentBytes: this.config.fragmentBytes, ...this.source === 'collector' ? { source: 'collector' } : {} })
    try {
      if (await readBoundedFile(path, 8192) !== identity) throw new DeliveryError('TRAJECTORY_DESTINATION_CHANGED', false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if ((await readdir(this.config.stateDir)).some(file => /^[a-f0-9]{64}\.json$/.test(file))) {
        throw new DeliveryError('TRAJECTORY_DESTINATION_MISSING', false)
      }
      await writeFileAtomic(path, identity, { mode: 0o600, dirMode: 0o700 })
    }
  }

  private async send(value: string, identity: RecordIdentity): Promise<void> {
    const requests = this.encoder.encode(value, identity, this.config.fragmentBytes, this.config.maxRequestBytes)
    for (const request of requests) {
      let attempt = 0
      for (;;) {
        this.signal.throwIfAborted()
        try {
          await deliver(this.config, request, this.signal)
          break
        } catch (error) {
          this.signal.throwIfAborted()
          if (!(error instanceof DeliveryError) || !error.retryable) throw error
          this.ctx.logger.warn(`Trajectory delivery retrying (${error.code}); persisted history retained.`)
          await this.health('retrying', error.code)
          const exponential = Math.min(this.config.retryMaxMs, this.config.retryInitialMs * 2 ** Math.min(attempt++, 30))
          let remaining = Math.max(error.retryAfterMs, Math.ceil(exponential * (0.5 + Math.random() * 0.5)))
          // Node timers overflow above int32; long server-directed waits remain cancellable.
          while (remaining > 0) {
            const wait = Math.min(remaining, 2_147_483_647)
            await delay(wait, undefined, { signal: this.signal })
            remaining -= wait
          }
        }
      }
    }
    this.acknowledged++
    await this.health('exporting')
  }

  private async exportSession(persistence: SessionPersistence, id: SessionId): Promise<boolean> {
    const handle = await persistence.open(id, 'read', { signal: this.signal })
    try {
      const header = JSON.stringify({ header: handle.header, inheritedEventCount: handle.inheritedEventCount })
      const headerHash = digest(header)
      const path = join(this.config.stateDir, `${digest(id)}.json`)
      let cursor: Cursor | undefined
      try {
        const value: unknown = JSON.parse(await readBoundedFile(path, 8192))
        cursor = z.resolve(value, Checkpoint, {})[0] as Cursor
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DeliveryError('TRAJECTORY_CHECKPOINT_INVALID', false)
      }
      if (cursor === undefined) {
        await this.send(header, { sourceId: this.config.sourceId, sessionId: id, sequence: -1, type: 'session/header', timestamp: handle.header.createdAt })
        cursor = { schema: 1, sessionId: id, headerHash, nextSeq: 0, lastHash: '' }
        await writeFileAtomic(path, JSON.stringify(cursor), { mode: 0o600, dirMode: 0o700 })
      }
      if (cursor.sessionId !== id || cursor.headerHash !== headerHash || (cursor.nextSeq === 0) !== (cursor.lastHash === '')) {
        throw new DeliveryError('TRAJECTORY_SOURCE_CHANGED', false)
      }
      if (cursor.nextSeq > 0) {
        const previous = (await handle.read(cursor.nextSeq - 1, 1, { signal: this.signal })).events[0]
        if (previous === undefined || digest(JSON.stringify(previous)) !== cursor.lastHash) throw new DeliveryError('TRAJECTORY_SOURCE_CHANGED', false)
      }
      const { events } = await handle.read(cursor.nextSeq, this.config.eventsPerSession, { signal: this.signal })
      for (const event of events) {
        const value = JSON.stringify(event)
        await this.send(value, {
          sourceId: this.config.sourceId, sessionId: id, sequence: event.seq, type: event.type, timestamp: event.time,
        })
        cursor.nextSeq = event.seq + 1
        cursor.lastHash = digest(value)
        await writeFileAtomic(path, JSON.stringify(cursor), { mode: 0o600, dirMode: 0o700 })
      }
      return events.length < this.config.eventsPerSession
    } finally { await handle.close() }
  }

  private async exportCollected(collector: TrajectoryCollector): Promise<void> {
    const destination = digest(JSON.stringify({ endpoint: this.config.endpoint, sourceId: this.config.sourceId,
      fragmentBytes: this.config.fragmentBytes, source: 'collector' }))
    const status = await collector.status()
    // Bind the durable high-water mark even when the store is empty; a destination change cannot silently skip records.
    await collector.markExported(destination, status.exportedCursor)
    const page = await collector.read({ after: status.exportedCursor, limit: this.config.eventsPerSession,
      maxBytes: this.config.collectorBatchBytes })
    for (const record of page.records) {
      this.signal.throwIfAborted()
      await this.send(record.content, { sourceId: this.config.sourceId, sessionId: record.sessionId,
        sequence: record.sequence, type: record.type, timestamp: record.timestamp, course: record.identity,
        collectorRecordId: record.id })
      await collector.markExported(destination, record.cursor)
    }
  }

  async run(): Promise<void> {
    try {
      await withFileLock(join(this.config.stateDir, 'owner'), async () => {
        try {
          await this.bindDestination()
          await this.health('starting')
          for (;;) {
            this.signal.throwIfAborted()
            if (this.source === 'collector') await this.exportCollected(this.ctx.trajectoryCollector)
            else {
              const persistence = this.ctx.sessionPersistence
              const sessions = await persistence.list({ signal: this.signal })
              for (const snapshot of sessions) {
                if (this.revisions.get(snapshot.header.id) === snapshot.revision) continue
                if (await this.exportSession(persistence, snapshot.header.id)) this.revisions.set(snapshot.header.id, snapshot.revision)
              }
            }
            await this.health('idle')
            await delay(this.config.pollIntervalMs, undefined, { signal: this.signal })
          }
        } catch (error) {
          if (this.signal.aborted) await this.health('stopped')
          else {
            const code = error instanceof DeliveryError ? error.code : 'TRAJECTORY_EXPORT_FAILED'
            this.ctx.logger.error(`Trajectory export stopped (${code}); inspect source, credentials and checkpoints before reload. History retained.`)
            await this.health('failed', code)
            this.onFailure()
          }
        }
      }, { signal: this.signal, waitMs: this.config.lockWaitMs })
    } catch (error) {
      if (!this.signal.aborted) {
        void error
        this.ctx.logger.error('Trajectory collector ownership or storage unavailable; export stopped. Run one collector per private state directory.')
        this.onFailure()
      }
    } finally {
      await this.encoder.close()
    }
  }
}

/** Start an acknowledgement-aware worker and abort/drain it when its plugin unloads.
 * @param ctx - Context with the selected source provider mounted.
 * @param config - Explicit full-content authorization, destination, credentials, and budgets.
 * @param source - Source selected by the owning plugin entry, never event content.
 * @returns Completion after validating deployment configuration and private credential access.
 */
export async function startWorker(ctx: Context, config: Config, source: 'persistence' | 'collector'): Promise<void> {
  const exit = ctx.get('appExit')
  try { await start(ctx, config, () => { exit?.(1) }, source) }
  catch (error) {
    ctx.logger.error('Trajectory export startup failed (TRAJECTORY_STARTUP_FAILED); no delivery began. Check the private token file and deployment configuration before reload.')
    exit?.(1)
    throw error
  }
}

async function start(ctx: Context, config: Config, onFailure: () => void, source: 'persistence' | 'collector'): Promise<void> {
  const endpoint = new URL(config.endpoint)
  const loopback = ['127.0.0.1', '[::1]'].includes(endpoint.hostname)
  if ((endpoint.protocol !== 'https:' && !(config.allowInsecureLoopback && loopback && endpoint.protocol === 'http:'))
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !endpoint.pathname.endsWith('/v1/logs')) {
    throw new Error('trajectory endpoint must be an HTTPS OTLP /v1/logs URL without credentials, query or fragment')
  }
  if (config.retryMaxMs < config.retryInitialMs || config.maxRequestBytes < config.fragmentBytes * 2 + 4096) {
    throw new Error('trajectory retry/request budgets are inconsistent')
  }
  await readToken(config.tokenFile)
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
  const lifetime = new AbortController()
  const worker = new ExportWorker(ctx, config, lifetime.signal, onFailure, source)
  const pending = worker.run().catch((error: unknown) => {
    // Logging a failed health-file write must not reveal file contents or credentials.
    void error
    ctx.logger.error('Trajectory worker failed to finalize; export stopped. Check collector storage and reload.')
    onFailure()
  })
  ctx.effect(() => async () => { lifetime.abort(); await pending })
}
