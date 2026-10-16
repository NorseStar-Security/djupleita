/** Recon page registration in the first-party runtime UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-experimental-course-runtime/client'
/** Runtime UI service owns the form and its lifecycle. */
export const inject = ['courseRuntimeUi']
/** Register while the recon bundle is enabled. @param ctx - browser plugin context. */
export function apply(ctx: Context): void { ctx.effect(() => ctx.courseRuntimeUi.registerRecon(), 'course recon settings') }
