/** First-party plugin pages and native management seat available from either runtime. */
import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Selection } from './RuntimeSelector.tsx'
import { RuntimeSelector } from './RuntimeSelector.tsx'
import { ScopePage, ReconPage } from './CoursePage.tsx'
import { PageModel } from './model.ts'
import { isolatedReady, runtimeTarget } from './navigation.ts'
import { en, zh, type LocaleKey } from './locales.ts'

export type { LocaleKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'course.runtime': LocaleKey } }
declare module '@deepseek-ai/cordis' { interface Context { courseRuntimeUi: CourseRuntimeUi } }

/** Keep management pinned to the native URL, independently of the selected backend. */
export class CourseRuntimeUi extends Service {
  constructor(ctx: Context, private readonly management: string) { super(ctx, 'courseRuntimeUi') }
  /** Mount the optional Recon page with its own unsaved editor.
   * @returns Cleanup that removes the page and stops its polling. */
  registerRecon(): () => void {
    const model = new PageModel(this.management)
    const release = this.ctx.slots.inject('plugins.bundle.config', () => this.ctx.slots.register({ name: 'plugins.bundle.config', key: '@deepseek-ai/dsh-experimental-recon-bundle',
      locale: 'course.runtime', inject: () => model.face() }, ReconPage))
    return () => { release(); model.dispose() }
  }
}
/** Required browser services. */
export const inject = ['slots', 'locale']
/** Register Scope and runtime selection; all backend RPC keeps its existing relative transport. */
export function apply(ctx: Context): void {
  const selected = location.pathname.startsWith('/runtimes/course/') ? 'course' : 'local'
  const management = `${location.origin}/`
  ctx.plugin(CourseRuntimeUi, management)
  ctx.effect(() => ctx.locale.register('course.runtime', { en, zh }), 'course runtime: dictionaries')
  const model = new PageModel(management)
  ctx.effect(() => () => { model.dispose() }, 'course runtime: editor')
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: '@deepseek-ai/dsh-experimental-network-scope-bundle',
    locale: 'course.runtime', inject: () => model.face() }, ScopePage))
  const setup = (): void => { ctx.get('pluginNavigation')?.openBundle('@deepseek-ai/dsh-experimental-network-scope-bundle') }
  const selection: Selection = { selected, hooks: { course: model.store }, select: (runtime) => {
    if (runtime === selected) return
    if (runtime === 'course' && !isolatedReady(model.store.getSnapshot())) { setup(); return }
    try { sessionStorage.setItem(`dsh.runtime.location.${selected}`, location.pathname + location.search + location.hash) } catch { /* A disabled storage area only loses the last selection. */ }
    let saved: string | null = null
    try {
      saved = sessionStorage.getItem(`dsh.runtime.location.${runtime}`)
    } catch { /* Admission still requires readiness when remembered locations are unavailable. */ }
    location.assign(runtimeTarget(runtime, saved, location.origin))
  } }
  ctx.slots.inject('sidebar.runtime', () => ctx.slots.register({ name: 'sidebar.runtime', locale: 'course.runtime', inject: () => selection }, RuntimeSelector))
  const deployment: unknown = Reflect.get(globalThis, '__DSH_COURSE_RUNTIME_CONFIG__')
  const allowHostResearch = deployment !== null && typeof deployment === 'object' && Reflect.get(deployment, 'allowHostResearch') === true
  if (selected === 'local' && !allowHostResearch) {
    const administrative = new URLSearchParams(location.search).get('course-management') === '1'
    ctx.inject(['pluginNavigation'], (navigation) => {
      setup()
      if (administrative) return
      let leaving = false
      const admit = (): void => {
        if (leaving || !isolatedReady(model.store.getSnapshot())) return
        leaving = true
        selection.select('course')
      }
      navigation.effect(() => model.store.subscribe(admit), 'course runtime: observed research admission')
      admit()
    })
  }
}
