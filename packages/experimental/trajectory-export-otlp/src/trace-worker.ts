/** Lifecycle-owned trace delivery from immutable completion pages and an independent private checkpoint. */
import { mkdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-projection'
import z from '@deepseek-ai/schemastery'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { encodeSpan } from './trace-encoding.ts'
import { deliver, DeliveryError, readBoundedFile, readToken } from './transport.ts'

/** Instructor-controlled delivery and complete projection-page budgets for the optional trace signal. */
export interface Config {
  /** Full HTTPS OTLP /v1/traces URL, without credentials, query, or fragment. */
  endpoint: string
  /** Absolute rotating instructor token file; never distributed in a student image. */
  tokenFile: string
  /** Absolute private directory dedicated to this trace exporter, not the logs exporter. */
  stateDir: string
  /** Instructor-assigned remote resource namespace, not a student identity claim. */
  sourceId: string
  /** Required consent: projected arguments and selected facts can contain sensitive content. */
  allowFullContent: true
  /** Permit plaintext HTTP only to literal loopback for protocol tests. */
  allowInsecureLoopback: boolean
  /** Maximum immutable completed spans read in one page. */
  spansPerPage: number
  /** Maximum complete serialized projection page bytes. */
  pageBytes: number
  /** Maximum complete encoded single-span OTLP request bytes; no attribute clipping. */
  maxRequestBytes: number
  /** Maximum complete response bytes after decompression. */
  maxResponseBytes: number
  /** Whole request and response deadline in milliseconds. */
  timeoutMs: number
  /** Delay after each completion-page scan in milliseconds. */
  pollIntervalMs: number
  /** Initial exponential retry delay with jitter in milliseconds. */
  retryInitialMs: number
  /** Maximum exponential delay; a larger server Retry-After remains authoritative. */
  retryMaxMs: number
  /** Same-host owner-lock wait in milliseconds; shared cross-host state is unsupported. */
  lockWaitMs: number
}

const milliseconds = () => z.natural().min(1).max(2_147_483_647)
const absolute = z.transform(z.string().required(), (value) => {
  if (!isAbsolute(value)) throw new Error('trace exporter paths must be absolute')
  return value
})

/** Trace export is separately mounted and requires explicit full-content consent. */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(), tokenFile: absolute, stateDir: absolute,
  sourceId: z.string().min(1).max(256).required(), allowFullContent: z.const(true).required(),
  allowInsecureLoopback: z.boolean().default(false), spansPerPage: z.natural().min(1).max(4096).default(128),
  pageBytes: z.natural().min(1).max(128 * 1024 * 1024).default(4 * 1024 * 1024),
  maxRequestBytes: z.natural().min(1024).max(4 * 1024 * 1024).default(256 * 1024),
  maxResponseBytes: z.natural().min(1).max(1024 * 1024).default(64 * 1024),
  timeoutMs: milliseconds().default(15_000), pollIntervalMs: milliseconds().default(1000),
  retryInitialMs: milliseconds().default(1000), retryMaxMs: milliseconds().default(60_000),
  lockWaitMs: milliseconds().default(2000),
})

const checkpointSchema = z.object({
  schema: z.const(1).required(), endpoint: z.string().required(), sourceId: z.string().required(),
  projectionId: z.string().required(), completionCursor: z.natural().max(Number.MAX_SAFE_INTEGER).required(),
})
interface Checkpoint { schema: 1; endpoint: string; sourceId: string; projectionId: string; completionCursor: number }

class TraceWorker {
  private acknowledged = 0
  constructor(private readonly ctx: Context, private readonly config: Config, private readonly signal: AbortSignal) {}

  private async health(state: string, code?: string): Promise<void> {
    await writeFileAtomic(join(this.config.stateDir, 'health.json'), JSON.stringify({ schema: 1, signal: 'traces', state, code,
      acknowledgedThisRun: this.acknowledged, sourceId: this.config.sourceId, updatedAt: Date.now() }), { mode: 0o600, dirMode: 0o700 })
  }

  private async loadCheckpoint(): Promise<Checkpoint> {
    const status = await this.ctx.trajectoryProjection.status()
    let value: Checkpoint
    try {
      value = z.resolve(JSON.parse(await readBoundedFile(join(this.config.stateDir, 'traces.json'), 8192)), checkpointSchema, {})[0] as Checkpoint
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new DeliveryError('TRAJECTORY_TRACE_CHECKPOINT_INVALID', false)
      value = { schema: 1, endpoint: this.config.endpoint, sourceId: this.config.sourceId,
        projectionId: status.projectionId, completionCursor: 0 }
      await this.saveCheckpoint(value)
    }
    if (value.endpoint !== this.config.endpoint || value.sourceId !== this.config.sourceId || value.projectionId !== status.projectionId
      || value.completionCursor > status.completedCursor) throw new DeliveryError('TRAJECTORY_TRACE_SOURCE_CHANGED', false)
    return value
  }

  private async saveCheckpoint(value: Checkpoint): Promise<void> {
    await writeFileAtomic(join(this.config.stateDir, 'traces.json'), JSON.stringify(value), { mode: 0o600, dirMode: 0o700 })
  }

  private async send(payload: Uint8Array): Promise<void> {
    let attempt = 0
    for (;;) {
      this.signal.throwIfAborted()
      try { await deliver(this.config, payload, this.signal, 'traces'); return }
      catch (error) {
        this.signal.throwIfAborted()
        if (!(error instanceof DeliveryError) || !error.retryable) throw error
        this.ctx.logger.warn(`Trajectory traces retrying (${error.code}); completion checkpoint retained.`)
        await this.health('retrying', error.code)
        const ceiling = Math.min(this.config.retryMaxMs, this.config.retryInitialMs * 2 ** Math.min(attempt++, 30))
        let wait = Math.max(error.retryAfterMs, Math.ceil(ceiling * (0.5 + Math.random() * 0.5)))
        while (wait > 0) {
          const interval = Math.min(wait, 2_147_483_647)
          await delay(interval, undefined, { signal: this.signal })
          wait -= interval
        }
      }
    }
  }

  async run(): Promise<void> {
    await withFileLock(join(this.config.stateDir, 'owner'), async () => {
      try {
        const checkpoint = await this.loadCheckpoint()
        await this.health('starting')
        for (;;) {
          this.signal.throwIfAborted()
          const status = await this.ctx.trajectoryProjection.status()
          if (status.state === 'failed') throw new DeliveryError('TRAJECTORY_PROJECTION_FAILED', false)
          const page = await this.ctx.trajectoryProjection.readCompleted({ after: checkpoint.completionCursor,
            limit: this.config.spansPerPage, maxBytes: this.config.pageBytes })
          if (page.projectionId !== checkpoint.projectionId) throw new DeliveryError('TRAJECTORY_TRACE_SOURCE_CHANGED', false)
          for (const span of page.spans) {
            await this.health('exporting')
            await this.send(encodeSpan(span, this.config.sourceId, this.config.maxRequestBytes))
            this.signal.throwIfAborted()
            checkpoint.completionCursor = span.completionCursor
            await this.saveCheckpoint(checkpoint)
            this.acknowledged++
          }
          await this.health('idle')
          await delay(this.config.pollIntervalMs, undefined, { signal: this.signal })
        }
      } catch (error) {
        if (this.signal.aborted) await this.health('stopped')
        else {
          const code = error instanceof DeliveryError ? error.code : 'TRAJECTORY_TRACE_EXPORT_FAILED'
          this.ctx.logger.error(`Trajectory trace export stopped (${code}); retain the projection and inspect credentials/checkpoints before reload.`)
          await this.health('failed', code)
          this.ctx.get('appExit')?.(1)
        }
      }
    }, { signal: this.signal, waitMs: this.config.lockWaitMs })
  }
}

/**
 * Validate trace delivery and own its worker until every request and checkpoint operation settles.
 * @param ctx - Owning Context with the durable projection provider.
 * @param config - Separate trace destination, consent, state directory, and complete budgets.
 * @returns Completion after configuration and rotating token validation, before background export.
 */
export async function startTraceWorker(ctx: Context, config: Config): Promise<void> {
  try {
    const endpoint = new URL(config.endpoint)
    const local = config.allowInsecureLoopback && ['127.0.0.1', '[::1]'].includes(endpoint.hostname) && endpoint.protocol === 'http:'
    if ((endpoint.protocol !== 'https:' && !local) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || !endpoint.pathname.endsWith('/v1/traces') || config.retryMaxMs < config.retryInitialMs) {
      throw new Error('trace exporter requires an HTTPS /v1/traces URL and consistent retry budgets')
    }
    await readToken(config.tokenFile)
    await mkdir(config.stateDir, { recursive: true, mode: 0o700 })
    const lifetime = new AbortController()
    const pending = new TraceWorker(ctx, config, lifetime.signal).run().catch((error: unknown) => {
      void error
      if (lifetime.signal.aborted) return
      ctx.logger.error('Trajectory trace worker could not finalize; retain its projection and private state, then inspect storage or owner lock.')
      ctx.get('appExit')?.(1)
    })
    ctx.effect(() => async () => { lifetime.abort(); await pending })
  } catch (error) {
    ctx.logger.error('Trajectory trace startup failed; no delivery began. Check the private token file, endpoint, and explicit consent.')
    ctx.get('appExit')?.(1)
    throw error
  }
}
