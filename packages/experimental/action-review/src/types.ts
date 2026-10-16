/** Immutable tool admission requests and trusted gateway acknowledgements. */
import type { Branded, BrandedNumber } from '@deepseek-ai/dsh-brand'
import type { ToolCallId, ToolSchema } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** SHA-256 identity of an immutable action-review deployment. */
export type ActionReviewHash = Branded<'ActionReviewHash'>
/** SHA-256 identity of the exact submitted UTF-8 request bytes. */
export type ActionInputHash = Branded<'ActionInputHash'>
/** Durable gateway admission row; never a reusable execution permission. */
export type ActionReviewReceipt = BrandedNumber<'ActionReviewReceipt'>

/** One executable action; null Session identity always prevents dispatch. */
export interface ReviewAction {
  readonly callId: ToolCallId
  readonly rootCallId: ToolCallId
  readonly parentCallId?: ToolCallId
  readonly sessionId: SessionId | null
  readonly tool: string
  readonly arguments: JsonValue
  readonly schema?: ToolSchema
}

/** Freshly observed external destination policy bound to one action. */
export interface ReviewRequest {
  readonly action: ReviewAction
  readonly policyHash: string
}

/** Independent evaluator findings; policy, not the provider, owns their thresholds. */
export interface ActionRiskFinding {
  readonly evaluator: string
  readonly model: string
  readonly risks: Readonly<Record<string, number>>
}

/** Deployment identity and current admission readiness; not an execution permit. */
export interface ActionReviewStatus {
  readonly protocol: 1
  readonly instance: string
  readonly policyHash: string
  readonly reviewHash: ActionReviewHash
  readonly ready: boolean
}

/** A complete, durably committed review bound to the submitted bytes and policy. */
export interface ActionReviewDecision extends Omit<ActionReviewStatus, 'ready'> {
  readonly inputHash: ActionInputHash
  readonly decision: 'allow' | 'deny'
  readonly code: string
  readonly findings: readonly ActionRiskFinding[]
  readonly receipt: ActionReviewReceipt
}

/** Failures never authorize a tool; integrity/audit failures require a process restart. */
export type ActionReviewErrorCode = 'ACTION_REVIEW_UNAVAILABLE' | 'ACTION_REVIEW_INVALID_RESPONSE'
  | 'ACTION_REVIEW_CHANGED' | 'ACTION_REVIEW_INPUT' | 'ACTION_REVIEW_AUDIT' | 'ACTION_REVIEW_STOPPED'
