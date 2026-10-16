/** Optional experimental Recon presence; the native runtime owns activation. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-course-runtime'
/** Wait for the native or research runtime presence seat. */
export const inject = ['courseRuntime']
/** Register the bundle with lifecycle ownership. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.courseRuntime.registerRecon(), 'course recon bundle presence')
}
