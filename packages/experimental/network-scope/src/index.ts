/** Replaceable read-only scope inspection service; enforcement remains instructor-owned. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ScopeInspection, ScopeTarget } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Read-only instructor policy, readiness, decisions, and environment audit. */
    networkScope: NetworkScopePolicy
  }
}

/** Expected transport, integrity, or audit-continuity failure; no permission is granted. */
export class NetworkScopeError extends Error {
  override readonly name = 'NetworkScopeError'
  constructor(readonly code: 'SCOPE_UNAVAILABLE' | 'SCOPE_INVALID_RESPONSE' | 'SCOPE_CHANGED' | 'SCOPE_AUDIT_GAP', options?: ErrorOptions) {
    super(`Network scope inspection failed (${code}); stop research and ask the instructor to restore the boundary.`, options)
  }
}

/** Implementations cannot widen scope; they only inspect an externally enforced policy. */
export abstract class NetworkScopePolicy extends Service {
  constructor(ctx: Context) { super(ctx, 'networkScope') }

  /**
   * Inspect readiness and targets while reading events starting at `after` (inclusive).
   * Omit `after` to establish a current cursor without replaying earlier activity.
   * Reject invalid, changed, unavailable, or overwritten observations; observe cancellation.
   * @param after - Inclusive audit cursor, or undefined to start at the current position.
   * @param targets - Structured HTTP targets to check against the immutable policy.
   * @param signal - Caller-owned cancellation signal.
   * @returns A detached, immutable policy, readiness, decision, and contiguous audit observation.
   */
  abstract inspect(after: number | undefined, targets: readonly ScopeTarget[], signal: AbortSignal): Promise<ScopeInspection>
}

export default NetworkScopePolicy
