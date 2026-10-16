/** Collector values retain original content separately from server-trusted identity. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Identity of one enrolled installation, assigned by the authorization service. */
export type InstallationId = Branded<'CourseInstallationId'>
/** Student identity assigned by the course service. */
export type StudentId = Branded<'CourseStudentId'>
/** Course membership assigned by the course service. */
export type CohortId = Branded<'CourseCohortId'>
/** Immutable record receipt identity. */
export type TrajectoryRecordId = Branded<'TrajectoryRecordId'>
/** Installation-scoped content identity for archived binary data. */
export type TrajectoryArtifactId = Branded<'TrajectoryArtifactId'>

/** Only the configured authorization provider or trusted local archive configuration supplies these values. */
export interface CollectorIdentity { installationId: InstallationId; studentId: StudentId; cohortId: CohortId }

/** Immutable record bytes; sequence -1 is the session header, otherwise the original event sequence. */
export interface TrajectoryRecord {
  sessionId: SessionId
  sequence: number
  type: string
  timestamp: number
  content: string
}

/** An acknowledged record has committed content and server-derived identity. */
export interface CollectedRecord extends TrajectoryRecord {
  id: TrajectoryRecordId
  cursor: number
  sha256: string
  receivedAt: number
  identity: CollectorIdentity
}

/** A receipt is returned only after a durable commit or exact replay verification. */
export interface CollectorReceipt { id: TrajectoryRecordId; sha256: string; duplicate: boolean }

/** Content-addressed binary data is always downloaded as an attachment, never rendered as executable content. */
export interface CollectedArtifact {
  id: TrajectoryArtifactId
  identity: CollectorIdentity
  sha256: string
  name: string
  receivedAt: number
  data: Uint8Array
}

/** Bounded, stable cursor pagination; filters are exact values, not SQL or patterns. */
export interface CollectorQuery {
  after: number
  limit: number
  maxBytes: number
  installationId?: InstallationId
  cohortId?: CohortId
  studentId?: StudentId
  sessionId?: SessionId
}

/** Complete bounded page and its next exclusive cursor. */
export interface CollectorPage { records: CollectedRecord[]; nextCursor: number; hasMore: boolean }
/** Committed storage counters and acknowledgement position for the primary remote destination. */
export interface CollectorStatus {
  records: number
  artifacts: number
  contentBytes: number
  revokedInstallations: number
  lastCursor: number
  exportedCursor: number
  exportDestination: string | null
}

/** Course-issued JWTs must be short-lived and limited to ingestion; SSO enrollment is a separate deployment. */
export interface UploadCredential { token: string; expiresAt: number; identity: CollectorIdentity }
