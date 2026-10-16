/** Replaceable collector storage, upload authorization, and installation credential services. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { CollectedArtifact, CollectorIdentity, CollectorPage, CollectorQuery, CollectorReceipt, CollectorStatus, InstallationId, TrajectoryArtifactId, TrajectoryRecord, UploadCredential } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    trajectoryCollector: TrajectoryCollector
    trajectoryUploadAuth: TrajectoryUploadAuth
    trajectoryCredentials: TrajectoryCredentials
  }
}

/** Failures never include credential values or uploaded content. */
export class CollectorError extends Error {
  constructor(readonly code: 'COLLECTOR_INPUT' | 'COLLECTOR_CONFLICT' | 'COLLECTOR_QUOTA' | 'COLLECTOR_STORAGE' | 'COLLECTOR_AUTH' | 'COLLECTOR_REVOKED' | 'COLLECTOR_UNAVAILABLE', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'CollectorError'
  }
}

/** Durable append-only intake and instructor inspection; no research execution capability. */
export abstract class TrajectoryCollector extends Service {
  constructor(ctx: Context) { super(ctx, 'trajectoryCollector') }
  /** Commit one whole record; exact replay deduplicates, conflicting bytes reject.
   * @param identity - trusted authorization result.
   * @param record - bounded complete JSON record.
   * @returns durable receipt.
   */
  abstract append(identity: CollectorIdentity, record: TrajectoryRecord): Promise<CollectorReceipt>
  /** Query complete records without clipping content.
   * @param query - exact filters and byte/item budgets.
   * @returns cursor page; oversized first records reject.
   */
  abstract read(query: CollectorQuery): Promise<CollectorPage>
  /** Commit one complete binary with a caller-declared digest.
   * @param identity - trusted sender.
   * @param artifact - content digest, display name, and bytes.
   * @returns durable content-addressed identity.
   */
  abstract putArtifact(identity: CollectorIdentity,
    artifact: { sha256: string; name: string; data: Uint8Array }): Promise<TrajectoryArtifactId>
  /** Read a committed artifact in one installation.
   * @param installation - trusted installation selector.
   * @param id - stored artifact identity.
   * @returns complete bytes or undefined.
   */
  abstract getArtifact(installation: InstallationId, id: TrajectoryArtifactId): Promise<CollectedArtifact | undefined>
  /** Revoke future writes without deleting existing evidence.
   * @param installation - installation to revoke.
   */
  abstract revoke(installation: InstallationId): Promise<void>
  /** Check the durable installation revocation list.
   * @param installation - installation identity.
   * @returns whether writes are revoked.
   */
  abstract isRevoked(installation: InstallationId): Promise<boolean>
  /** Read storage and primary-export high-water marks.
   * @returns current durable counters.
   */
  abstract status(): Promise<CollectorStatus>
  /** Bind one primary export destination and acknowledge only a successfully delivered prefix.
   * @param destination - non-secret destination fingerprint.
   * @param cursor - committed collector cursor.
   */
  abstract markExported(destination: string, cursor: number): Promise<void>
  /** Delete only an exported, old prefix; binary retention remains explicit.
   * @param destination - bound primary destination.
   * @param before - receipt timestamp cutoff.
   * @returns deleted record count.
   */
  abstract pruneExported(destination: string, before: number): Promise<number>
}

/** Authorization is a separate provider; absence never enables anonymous ingestion. */
export abstract class TrajectoryUploadAuth extends Service {
  constructor(ctx: Context) { super(ctx, 'trajectoryUploadAuth') }
  /** Verify course-issued credentials, audience, expiry, membership, and write scope.
   * @param authorization - exact HTTP authorization value.
   * @param signal - request cancellation.
   * @returns server-trusted student/cohort/installation identity.
   */
  abstract authenticate(authorization: string | undefined, signal: AbortSignal): Promise<CollectorIdentity>
}

/** Installation-side enrollment and renewal remain outside the research process. */
export abstract class TrajectoryCredentials extends Service {
  constructor(ctx: Context) { super(ctx, 'trajectoryCredentials') }
  /** Obtain an audience-restricted, current ingestion credential; no interactive fallback.
   * @param signal - operation cancellation.
   * @returns current credential or a visible unavailable failure.
   */
  abstract get(signal: AbortSignal): Promise<UploadCredential>
}

export default TrajectoryCollector
