/** Instructor-only bounded inspection API. It cannot ingest records or control research tools. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-projection'
import { ViewerHttp } from './http.ts'
import type { Config } from './config.ts'

export { Config } from './config.ts'

/** Loader identity. */
export const name = 'trajectory-viewer'
/** All inspection dependencies are mandatory; no anonymous fallback exists. */
export const inject = ['webServer', 'connection', 'trajectoryCollector', 'trajectoryProjection']

/**
 * Register read-only routes for the optional browser plugin, draining active reads at unload.
 * @param ctx - plugin context with instructor Connection authentication.
 * @param config - validated live polling cadence published to browser pages.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRAJECTORY_VIEWER_CONFIG__', value: config })
  })
  const http = new ViewerHttp(ctx)
  ctx.effect(() => {
    const unregister: (() => void)[] = []
    try {
      for (const action of ['status', 'traces', 'detail', 'records']) {
        unregister.push(ctx.webServer.register({ kind: 'exact', path: `/api/trajectory-viewer/${action}`, handler: (req, res) => http.handle(req, res) }))
      }
    } catch (error) {
      for (const remove of unregister.reverse()) remove()
      throw error
    }
    return async () => { for (const remove of unregister) remove(); await http.dispose() }
  }, 'trajectory viewer: authenticated routes')
}
