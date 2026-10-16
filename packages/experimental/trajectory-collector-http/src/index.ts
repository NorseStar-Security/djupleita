/** Bounded HTTP intake and instructor inspection; enrollment and credential verification remain separate plugins. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-collector'
import { CollectorHttp } from './http.ts'

/** HTTP routes and complete request/response budgets. */
export interface Config {
  /** Absolute API pathname without a trailing slash. */
  path: string
  /** Absolute read-only HTML pathname without a trailing slash. */
  dashboardPath: string
  /** Own `/` for the existing instructor-local launch-token exchange; leave false when another Web app owns it. */
  serveRoot: boolean
  /** Maximum complete JSON record request bytes. */
  maxRecordBytes: number
  /** Maximum complete binary upload and download bytes. */
  maxArtifactBytes: number
  /** Maximum complete JSON or escaped HTML response bytes. */
  maxResponseBytes: number
  /** Maximum record content admitted into one instructor page before serialization. */
  maxQueryBytes: number
  /** Maximum number of complete records on one instructor page. */
  maxPageRecords: number
  /** Maximum active requests, including storage writes still settling after an HTTP timeout. */
  maxConcurrent: number
  /** Whole request deadline; started durable writes may complete after the response times out. */
  timeoutMs: number
}

const path = z.string().pattern(/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/)
/** Deployment-controlled routes and bounds; no token or anonymous-ingestion option exists. */
export const Config: z<Partial<Config>, Config> = z.object({
  path: path.default('/api/trajectory'), dashboardPath: path.default('/trajectory'),
  serveRoot: z.boolean().default(false),
  maxRecordBytes: z.natural().min(1).default(1048576),
  maxArtifactBytes: z.natural().min(1).default(16777216),
  maxResponseBytes: z.natural().min(1024).default(4194304),
  maxQueryBytes: z.natural().min(1).default(1048576),
  maxPageRecords: z.natural().min(1).default(100),
  maxConcurrent: z.natural().min(1).default(16),
  timeoutMs: z.natural().min(1).max(2147483647).default(30000),
})

/** Loader identity. */
export const name = 'trajectory-collector-http'
/** Storage and transport are mandatory; missing optional authorizers fail closed per request. */
export const inject = ['webServer', 'trajectoryCollector']

/**
 * Register owned collector routes; unload stops admission and drains every started storage operation.
 * @param ctx - owning plugin context.
 * @param config - resolved route and request budgets.
 */
export function apply(ctx: Context, config: Config): void {
  const paths = [...config.serveRoot ? ['/'] : [], config.dashboardPath, ...['records', 'artifacts', 'status'].map(value => `${config.path}/${value}`)]
  if (new Set(paths).size !== paths.length) throw new Error('trajectory collector HTTP routes must be distinct')
  const runtime = new CollectorHttp(ctx, config)
  ctx.effect(() => {
    const unregister: (() => void)[] = []
    try {
      for (const route of paths) unregister.push(ctx.webServer.register({ kind: 'exact', path: route, handler: (req, res) => runtime.handle(req, res) }))
    } catch (error) {
      for (const remove of unregister.reverse()) remove()
      throw error
    }
    return async () => {
      for (const remove of unregister) remove()
      await runtime.dispose()
    }
  }, 'trajectory collector HTTP: routes and active requests')
  if (config.serveRoot) {
    let announced = false
    ctx.inject(['connection'], (authCtx) => {
      if (announced) return
      announced = true
      authCtx.logger.info('Trajectory collector instructor login: %s', authCtx.connection.authenticatedUrl(ctx.webServer.getOrigin()))
    })
  }
}
