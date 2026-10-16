/** First-party experimental Scope/Recon management, confined to the native host. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackHost } from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import { RuntimeController } from './controller.ts'
import { proxyHttp, proxyUpgrade } from './proxy.ts'
import { nativeFeatures } from './features.ts'
import { mountProtectedArchive, mountResearchArchive } from './archive.ts'

/** Native deployment locations; never writable through browser settings. */
export interface Config {
  /** Instructor exposes native management; research exposes only activity inspection. */
  role: 'instructor' | 'research'
  /** Native source checkout containing the canonical Python gateway and image recipes. */
  sourceRoot: string
  /** Private native storage for drafts, immutable revisions and operation state, under harness-local. */
  stateRoot: string
  /** Explicit dedicated Docker context; never changes the user's active context. */
  dockerContext: string
  /** Native Python executable used for authoritative policy validation and deployment. */
  python: string
  /** Maximum duration of an owned image-build or lifecycle operation before termination. */
  operationTimeoutMs: number
  /** Delay between settled native pulls of Protected trajectory records. */
  archivePollIntervalMs: number
  /** Instructor-only escape for trusted host research; false keeps native tools management-only. */
  allowHostResearch: boolean
}
/** Deployment-only configuration; research has no management controller. */
export const Config: z<Config> = z.object({
  role: z.union(['instructor', 'research']).default('instructor'),
  sourceRoot: z.string().default('.'), stateRoot: z.string().default('harness-local/course-runtime'),
  dockerContext: z.string().default('colima-dsh-course'), python: z.string().default('python3'),
  archivePollIntervalMs: z.natural().min(1000).max(60000).default(2500),
  allowHostResearch: z.boolean().default(false),
  operationTimeoutMs: z.natural().min(1).max(2_147_483_647).default(3_600_000),
})

declare module '@deepseek-ai/cordis' {
  interface Context { courseRuntime: CourseRuntime }
}

/** Bundle presence seat; its research instance deliberately has no controller. */
export class CourseRuntime extends Service {
  private recon = 0
  constructor(ctx: Context, readonly controller?: RuntimeController) { super(ctx, 'courseRuntime') }
  /** Register the optional Recon bundle for runtime composition.
   * @returns Cleanup that unregisters the bundle presence. */
  registerRecon(): () => void {
    this.recon++
    this.controller?.setReconEnabled(this.recon > 0)
    return () => { this.recon--; this.controller?.setReconEnabled(this.recon > 0) }
  }
}

interface RequestTrust { requestRejection(req: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
function trust(ctx: Context): RequestTrust { return Reflect.get(ctx, 'connection') as RequestTrust }
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(String(part))
    size += chunk.length
    if (size > 1024 * 1024) throw new Error('Configuration exceeds 1 MiB')
    chunks.push(chunk)
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString())
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a configuration object')
  return value as Record<string, unknown>
}

/** Required native transport seats; authentication is the existing connection service. */
export const inject = ['webServer', 'connection']

/** Mount native administration or the research-only activity summary. */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_COURSE_RUNTIME_CONFIG__', value: { allowHostResearch: config.role === 'instructor' && config.allowHostResearch } })
  })
  if (config.role === 'instructor' && !config.allowHostResearch) {
    // A required course boundary must not turn into full host access on
    // consumer unload. Both the watcher and each registry denial belong to
    // the process root, including Tools providers mounted or replaced later.
    const admissionOwner = ctx.extend({ fiber: ctx.root.fiber })
    admissionOwner.inject(['tools'], (guarded) => {
      guarded.extend({ fiber: ctx.root.fiber }).tools.guard(() => 'Native host research is disabled. Configure and use the Isolated Linux runtime; the host is management-only.')
    })
  }
  const rejected = (req: IncomingMessage, res: ServerResponse): boolean => {
    const status = trust(ctx).requestRejection(req)
    if (status === undefined) return false
    res.writeHead(status); res.end(); return true
  }
  if (config.role === 'research') {
    ctx.plugin(CourseRuntime)
    ctx.on('plugin-manager/before-change', (change) => {
      if (change.enabled === true) return Promise.resolve()
      if (change.target.startsWith('course-') || ['@deepseek-ai/dsh-experimental-network-scope-bundle', '@deepseek-ai/dsh-experimental-recon-bundle'].includes(change.target)) {
        throw new Error('Stop Protected from the native Network Scope page before disabling or removing this plugin.')
      }
      return Promise.resolve()
    })
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/course-runtime/activity', handler: (req, res) => {
      if (rejected(req, res)) return
      if (req.method !== 'GET') {  json(res, 405, { error: 'GET required' }); return }
      const active = ctx.get('agents')?.list().filter(agent => agent.status === 'running').map(agent => `Session ${agent.session.id}`) ?? []
      json(res, 200, [...active, 'All research terminals, child processes, and background work will be stopped on apply.'])
    } }), 'course runtime: research activity')
    mountResearchArchive(ctx, rejected)
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/course-runtime', handler: (req, res) => {
      if (rejected(req, res)) return
      json(res, 403, { error: 'Runtime management is available only on the native host.' })
    } }), 'course runtime: no research administration')
    return
  }
  if (!isLoopbackHost(ctx.webServer.host)) throw new Error('Course runtime management requires a loopback-only native listener')
  // The listener binds before dependent plugins activate; use its concrete loopback origin.
  const controller = new RuntimeController(config, `${ctx.webServer.getOrigin()}/`, configuration => nativeFeatures(ctx, configuration.actionReview))
  ctx.plugin(CourseRuntime, controller)
  ctx.effect(() => { void controller.initialize().catch((error: unknown) => {  ctx.logger.error(error) }); return () => controller.dispose() }, 'course runtime: lifecycle')
  mountProtectedArchive(ctx, controller, config.archivePollIntervalMs)
  ctx.on('plugin-manager/before-change', async (change) => {
    if (change.enabled === true) return
    if (['@deepseek-ai/dsh-experimental-network-scope-bundle', '@deepseek-ai/dsh-experimental-recon-bundle',
      'course-runtime', 'course-recon-ui'].includes(change.target)) await controller.assertStopped()
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/course-runtime', handler: async (req, res) => {
    if (rejected(req, res)) return
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (path === '/course-runtime/status' && req.method === 'GET') {  json(res, 200, await controller.view()); return }
      if (path === '/course-runtime/validate' && req.method === 'POST') {  json(res, 200, await controller.validate((await body(req)).config)); return }
      if (path === '/course-runtime/draft' && req.method === 'POST') {
        const value = await body(req)
        if (!Number.isSafeInteger(value.revision)) throw new Error('Invalid revision')
        json(res, 200, await controller.save(Number(value.revision), value.config)); return
      }
      if (path === '/course-runtime/action' && req.method === 'POST') {
        const value = await body(req)
        if (!['prepare', 'apply', 'stop'].includes(String(value.action)) || !Number.isSafeInteger(value.revision) || typeof value.stopConfirmed !== 'boolean') throw new Error('Invalid runtime action')
        await controller.start({ action: value.action as 'prepare' | 'apply' | 'stop', revision: Number(value.revision), stopConfirmed: value.stopConfirmed })
        json(res, 202, { accepted: true }); return
      }
      json(res, 404, { error: 'Unknown course management route' })
    } catch (error) { json(res, 409, { error: error instanceof Error ? error.message : String(error) }) }
  } }), 'course runtime: native authenticated API')
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/runtimes/course', handler: async (req, res) => {
    if (rejected(req, res)) return
    if (req.url === '/runtimes/course') { res.writeHead(302, { location: '/runtimes/course/' }); res.end(); return }
    await proxyHttp(controller, req, res)
  } }), 'course runtime: protected HTTP bridge')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/runtimes/course/api/remote.mux', handler: async (req, socket, head) => {
    const status = trust(ctx).requestRejection(req)
    if (status !== undefined) { socket.end(`HTTP/1.1 ${status} Rejected\r\n\r\n`); return }
    await proxyUpgrade(controller, req, socket, head)
  } }), 'course runtime: protected stream bridge')
}
