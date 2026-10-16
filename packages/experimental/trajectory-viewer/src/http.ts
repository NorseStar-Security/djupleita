/** Read queries are bounded before providers run and again before response serialization. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { TraceId } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'

class QueryError extends Error {}
function number(value: string | null, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === null) return fallback
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new QueryError()
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result > max) throw new QueryError()
  return result
}
function text(value: string | null): string | undefined {
  if (value === null || value === '') return undefined
  if (Buffer.byteLength(value) > 256 || /[\u0000-\u001f]/u.test(value)) throw new QueryError()
  return value
}

/** Own route admission and provider-read settlement without exposing configuration or credentials. */
export class ViewerHttp {
  private closed = false
  private readonly pending = new Set<Promise<void>>()
  constructor(private readonly ctx: Context) {}

  /**
   * Authenticate and serve one bounded GET; dependency diagnostics are never reflected.
   * @param req - instructor request.
   * @param res - response owned until completion or disconnect.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, value: unknown): void => {
      if (res.destroyed || res.writableEnded) return
      const content = JSON.stringify(value)
      if (Buffer.byteLength(content) > 2097152) { send(413, { error: 'VIEWER_PAGE_TOO_LARGE' }); return }
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-length': String(Buffer.byteLength(content)) })
      res.end(content)
    }
    if (this.closed || this.pending.size >= 8) { send(503, { error: 'VIEWER_BUSY' }); return }
    const rejection = this.ctx.connection.requestRejection(req)
    if (rejection !== undefined) { send(rejection, { error: 'VIEWER_AUTH_REQUIRED' }); return }
    if (req.method !== 'GET') { res.setHeader('allow', 'GET'); send(405, { error: 'VIEWER_READ_ONLY' }); return }
    const deadline = setTimeout(() => { send(504, { error: 'VIEWER_TIMEOUT' }) }, 10000)
    const operation = this.read(req).then((value) => { send(200, value) }).catch((error: unknown) => {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      const quota = code === 'PROJECTION_QUOTA' || code === 'COLLECTOR_QUOTA'
      const input = error instanceof QueryError || code === 'PROJECTION_INPUT' || code === 'COLLECTOR_INPUT'
      send(quota ? 413 : input ? 400 : 503, { error: quota ? 'VIEWER_PAGE_TOO_LARGE' : input ? 'VIEWER_INVALID_QUERY' : 'VIEWER_UNAVAILABLE' })
    }).finally(() => { clearTimeout(deadline); this.pending.delete(operation) })
    this.pending.add(operation)
    await operation
  }

  /** Stop admission and wait for already-started provider reads. */
  async dispose(): Promise<void> { this.closed = true; await Promise.allSettled(this.pending) }

  private async read(req: IncomingMessage): Promise<unknown> {
    const url = new URL(String(req.url), 'http://viewer.invalid')
    const action = url.pathname.split('/').at(-1)
    const allowed = action === 'status' ? [] : action === 'detail' ? ['traceId', 'after', 'limit']
      : ['after', 'limit', 'installationId', 'studentId', 'cohortId', 'sessionId', ...action === 'traces' ? ['search', 'status', 'parentSessionId'] : []]
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) throw new QueryError()
    }
    const after = number(url.searchParams.get('after'), 0)
    const limit = number(url.searchParams.get('limit'), action === 'traces' ? 40 : 100, 100)
    if (!limit) throw new QueryError()
    if (action === 'status') return { collector: await this.ctx.trajectoryCollector.status(), projection: await this.ctx.trajectoryProjection.status() }
    if (action === 'detail') {
      const id = url.searchParams.get('traceId')
      if (id === null || !/^[a-f0-9]{32}$/.test(id)) throw new QueryError()
      return this.ctx.trajectoryProjection.detail({ traceId: id as TraceId, after, limit })
    }
    const filters: Record<string, string> = {}
    for (const key of ['installationId', 'studentId', 'cohortId', 'sessionId', 'parentSessionId', 'search', 'status']) {
      const value = text(url.searchParams.get(key))
      if (value !== undefined) filters[key] = value
    }
    if (filters.status !== undefined && !['running', 'completed', 'blocked', 'error', 'incomplete'].includes(filters.status)) throw new QueryError()
    if (action === 'traces') return this.ctx.trajectoryProjection.list({ after, limit, direction: 'newest', filters })
    if (action === 'records') return this.ctx.trajectoryCollector.read({ after, limit, maxBytes: 1048576, ...filters })
    throw new QueryError()
  }
}
