/** Replaceable action admission service; trusted reviewers and storage stay outside the worker. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ActionReviewDecision, ActionReviewErrorCode, ActionReviewStatus, ReviewRequest } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Keyless access to the trusted, policy-bound action reviewer. */
    actionReview: ActionReview
  }
}

/** Expected review failure; callers must withhold dispatch and retain visible diagnostics. */
export class ActionReviewError extends Error {
  override readonly name = 'ActionReviewError'
  constructor(readonly code: ActionReviewErrorCode, options?: ErrorOptions) {
    super(`Action review failed (${code}); tool dispatch is blocked. Ask the instructor to restore review and audit services.`, options)
  }
}

/** Providers must reject incomplete reviews, cancelled requests, and changed deployment identities. */
export abstract class ActionReview extends Service {
  constructor(ctx: Context) { super(ctx, 'actionReview') }

  /**
   * Read the current immutable review deployment and readiness.
   * @param signal - Caller-owned cancellation, also bounded by the provider lifetime and deadline.
   * @returns A detached observation; it never grants permission to execute.
   */
  abstract status(signal: AbortSignal): Promise<ActionReviewStatus>

  /**
   * Commit exactly one action review in trusted storage before returning its acknowledgement.
   * No authorization cache, worker-side model credentials, or approval fallback is permitted.
   * @param request - Complete immutable action and freshly observed network policy identity.
   * @param signal - Caller-owned cancellation, also bounded by the provider lifetime and deadline.
   * @returns A durably committed allow or deny acknowledgement for exactly this input.
   */
  abstract review(request: ReviewRequest, signal: AbortSignal): Promise<ActionReviewDecision>
}

export default ActionReview
