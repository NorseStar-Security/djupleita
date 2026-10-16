/** Copy immutable persistence records to the collector without changing the source log. */
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-cmdline'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from '@deepseek-ai/schemastery'
import { CollectorError } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type { CollectorIdentity } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { ArchiveError } from './errors.ts'
import { SessionArchive } from './archive.ts'

/** Loader identity of the persisted-session archive consumer. */
export const name = 'experimental-trajectory-collector-archive'
/** Attachment storage is required only when binary copying is explicitly enabled. */
export const inject = ['sessionPersistence', 'trajectoryCollector']

/** Trusted deployment identity and bounded polling; this is not student enrollment. */
export interface Config {
  /** Installation identity assigned by the trusted local deployment. */
  installationId: string
  /** Student identity assigned by the trusted local deployment. */
  studentId: string
  /** Cohort identity assigned by the trusted local deployment. */
  cohortId: string
  /** Delay between bounded scans, in milliseconds. */
  pollIntervalMs: number
  /** Maximum sessions visited per scan; later sessions rotate into subsequent scans. */
  maxSessionsPerScan: number
  /** Maximum events read and acknowledged per session visit. */
  eventsPerRead: number
  /** Maximum in-memory cursors; evicted sessions safely replay through collector deduplication. */
  maxCachedSessions: number
  /** Explicit consent to copy potentially sensitive image/file attachment bytes; false archives references only. */
  copyAttachments: boolean
  /** Maximum bytes of one copied attachment, enforced before and during reads. */
  maxArtifactBytes: number
  /** Maximum nesting depth inspected for canonical image/file parts when copying is enabled. */
  maxAttachmentDepth: number
  /** Maximum JSON values inspected per record; exhaustion rejects the record without acknowledgement. */
  maxAttachmentNodes: number
}

/** Identity is required; polling and resource limits are configurable deployment choices. */
export const Config: z<Config> = z.object({
  installationId: z.string().min(1).max(128).required(),
  studentId: z.string().min(1).max(128).required(),
  cohortId: z.string().min(1).max(128).required(),
  pollIntervalMs: z.natural().min(1).max(2_147_483_647).default(1000),
  maxSessionsPerScan: z.natural().min(1).max(100_000).default(100),
  eventsPerRead: z.natural().min(1).max(100_000).default(100),
  maxCachedSessions: z.natural().min(1).max(1_000_000).default(10_000),
  copyAttachments: z.boolean().default(false),
  maxArtifactBytes: z.natural().min(1).max(2_147_483_647).default(16_777_216),
  maxAttachmentDepth: z.natural().min(1).max(256).default(64),
  maxAttachmentNodes: z.natural().min(1).max(10_000_000).default(100_000),
})

/** Mount one cancellable poller; failures stop it visibly and disposal awaits in-flight commits. */
export function apply(ctx: Context, config: Config): void {
  const exit = ctx.get('appExit')
  const attachments = config.copyAttachments ? ctx.get('attachments') : undefined
  if (config.copyAttachments && attachments === undefined) {
    throw new ArchiveError('ARCHIVE_ATTACHMENT', 'copyAttachments requires a mounted attachment provider.')
  }
  const identity: CollectorIdentity = {
    installationId: brandString<CollectorIdentity['installationId']>(config.installationId),
    studentId: brandString<CollectorIdentity['studentId']>(config.studentId),
    cohortId: brandString<CollectorIdentity['cohortId']>(config.cohortId),
  }
  const mount = (owner: Context, store: AttachmentStore | undefined) => owner.effect(() => {
    const lifetime = new AbortController()
    const archive = new SessionArchive(owner.sessionPersistence, owner.trajectoryCollector, identity, config, store)
    const polling = archive.run(lifetime.signal).catch((error: unknown) => {
      if (lifetime.signal.aborted && (error === lifetime.signal.reason || error instanceof Error && error.name === 'AbortError')) return
      const code = error instanceof ArchiveError || error instanceof CollectorError ? error.code : 'ARCHIVE_SOURCE'
      owner.logger.error(`Trajectory archive stopped (${code}); source sessions are unchanged and a prefix may already be archived. Restore the collector, persistence, or attachments and reload this plugin to replay safely.`)
      exit?.(1)
    })
    return async () => {
      lifetime.abort()
      await polling
    }
  })
  if (config.copyAttachments) ctx.inject(['attachments'], (owner) => { mount(owner, owner.attachments) })
  else mount(ctx, undefined)
}
