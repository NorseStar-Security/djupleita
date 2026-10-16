/** Optional global Trajectories panel; no Session or tool capability is replaced. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { Trajectories, TrajectoryIcon } from './viewer.tsx'
import { provider } from './resources.ts'
import { en, zh, type LocaleKey } from './locales.ts'
import { Config } from '../config.ts'

export type { LocaleKey } from './locales.ts'
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'trajectory.viewer': LocaleKey } }
/** Required browser services. */
export const inject = ['slots', 'locale', 'resources']
/**
 * Add a sidebar destination and its read-only main panel through declared slots.
 * @param ctx - browser plugin context.
 */
export function apply(ctx: Context): void {
  const config = Config((globalThis as { __DSH_TRAJECTORY_VIEWER_CONFIG__?: unknown }).__DSH_TRAJECTORY_VIEWER_CONFIG__ ?? {})
  ctx.effect(() => ctx.locale.register('trajectory.viewer', { en, zh }), 'trajectory viewer: dictionaries')
  ctx.effect(() => ctx.resources.register(provider(config.pollIntervalMs, config.apiBasePath)), 'trajectory viewer: page resources')
  const t = ctx.locale.bind('trajectory.viewer')
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'trajectories', locale: 'trajectory.viewer' }, Trajectories))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'trajectories', order: 10,
    label: () => t('panel'), locale: 'trajectory.viewer' }, TrajectoryIcon))
}
