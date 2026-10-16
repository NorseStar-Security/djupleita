/** Browser-only attachment to an authenticated native archive; no collector or management credential enters research. */
import { Config } from './config.ts'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Loader identity for the research-side browser attachment. */
export const name = 'trajectory-viewer-native-management'
/** Research only publishes its browser configuration; it serves no native archive API. */
export const inject = ['webServer', 'connection']

/**
 * Mount the existing viewer client against the native same-origin read-only API.
 * @param ctx - research Web application; the browser supplies its own native cookie directly to the Mac.
 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_TRAJECTORY_VIEWER_CONFIG__',
      value: Config({ apiBasePath: '/api/trajectory-viewer/' }) })
  })
}
