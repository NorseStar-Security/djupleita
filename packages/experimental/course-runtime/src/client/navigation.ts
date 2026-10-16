/** Research admission uses observed runtime health; saved settings alone never authorize a runtime. */
import type { PageState } from './model.ts'

/**
 * Require a live observation of the saved, applied, and running revision, including trajectory intake.
 * @param state - Latest native management observation, retaining staged edits separately.
 * @returns Whether the Isolated Linux client may be selected.
 */
export function isolatedReady(state: PageState): boolean {
  const view = state.view
  return state.available && view !== undefined && view.runtime.phase === 'running' && view.runtime.healthy
    && view.runtime.prepared && view.runtime.actionReviewReady === true && view.trajectoryError === false && view.applied !== undefined
    && view.runtime.appliedRevision === view.applied.revision && view.applied.revision === view.draft.revision
}

/**
 * Restore only a same-origin location inside the requested mount; host navigation stays explicitly administrative.
 * @param runtime - Complete client mount to open.
 * @param saved - Previously visited location, or null when none was stored.
 * @param origin - Native same-origin URL.
 * @returns A relative URL that cannot silently select another execution runtime.
 */
export function runtimeTarget(runtime: 'local' | 'course', saved: string | null, origin: string): string {
  const fallback = runtime === 'course' ? '/runtimes/course/' : '/?course-management=1'
  if (!saved) return fallback
  let target: URL
  try { target = new URL(saved, origin) } catch { return fallback }
  if (target.origin !== origin || (runtime === 'course'
    ? !target.pathname.startsWith('/runtimes/course/') : target.pathname.startsWith('/runtimes/'))) return fallback
  if (runtime === 'local') target.searchParams.set('course-management', '1')
  return target.pathname + target.search + target.hash
}
