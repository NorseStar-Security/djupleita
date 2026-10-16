/** Browser-safe instructor configuration and runtime observations. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Complete saved deployment configuration; activation is a separate operation. */
export interface CourseConfiguration {
  policy: JsonValue
  provider: { socketPath: string; timeoutMs: number; maxResponseBytes: number }
  guard: { pollIntervalMs: number; targetTools: { name: string; urlField: string; methodField: string }[] }
  recon: Record<string, JsonValue>
  /** Missing on legacy drafts; applying requires an explicitly configured reviewer. */
  actionReview?: Record<string, JsonValue>
  forwardOpenAIKey: boolean
}

/** Durable revision of the settings shown by both plugin pages. */
export interface CourseDraft {
  revision: number
  config: CourseConfiguration
}

/** Observed container lifecycle, never an assertion based only on a saved draft. */
export interface CourseRuntimeState {
  phase: 'stopped' | 'preparing' | 'starting' | 'stopping' | 'running' | 'failed'
  prepared: boolean
  healthy: boolean
  researchStopped?: boolean
  appliedRevision?: number
  policyHash?: string
  actionReviewReady?: boolean
  reviewHash?: string
  error?: string | null
  detail?: string
}

/** Complete UI baseline; no launch tokens or credential values are returned. */
export interface CourseView {
  draft: CourseDraft
  applied?: CourseDraft
  defaults: CourseConfiguration
  runtime: CourseRuntimeState
  reconEnabled: boolean
  openAIKeyAvailable: boolean
  versions: Record<string, JsonValue>
  installedVersions?: Record<string, JsonValue>
  activity: string[]
  trajectoryError?: boolean
}

/** Explicit, revision-fenced runtime mutation sent by a user gesture. */
export interface CourseAction {
  action: 'prepare' | 'apply' | 'stop'
  revision: number
  stopConfirmed: boolean
}
