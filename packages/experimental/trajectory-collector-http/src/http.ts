/** Own each HTTP request through durable storage settlement, even after its client or deadline ends. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { CollectorError } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type { CollectorIdentity } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type { Config } from './index.ts'
import { artifactHeaders, artifactSelector, body, HttpFailure, query, record } from './parsing.ts'

const headers = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  connection: 'close',
}

function escape(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;') }

/** Per-plugin request admission and drain owner; contains no enrollment or token verifier. */
export class CollectorHttp {
  private closed = false
  private readonly pending = new Set<Promise<void>>()
  private readonly controllers = new Set<AbortController>()

  constructor(private readonly ctx: Context, private readonly config: Config) {}

  /**
   * Handle one admitted HTTP request and retain started storage until it settles.
   * @param req - incoming request.
   * @param res - response whose headers and terminal write this operation owns.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.closed || this.pending.size >= this.config.maxConcurrent) {
      this.failure(res, new HttpFailure(503, 'COLLECTOR_BUSY', 'The collector is unavailable or at its active-request limit; retry later.'))
      return
    }
    const controller = new AbortController()
    this.controllers.add(controller)
    const abort = () => { controller.abort(new HttpFailure(408, 'COLLECTOR_CANCELLED', 'The request ended; a started write may still commit.')) }
    const disconnect = () => { if (!res.writableFinished) abort() }
    req.once('aborted', abort)
    res.once('close', disconnect)
    const deadline = setTimeout(() => {
      const failure = new HttpFailure(503, 'COLLECTOR_TIMEOUT', 'The request deadline expired; a started write may still commit. Retry the exact payload.')
      controller.abort(failure)
      this.failure(res, failure)
    }, this.config.timeoutMs)
    const operation = this.dispatch(req, res, controller.signal).catch((error: unknown) => {
      this.failure(res, error)
    }).finally(() => {
      clearTimeout(deadline)
      req.off('aborted', abort); res.off('close', disconnect)
      this.controllers.delete(controller)
      this.pending.delete(operation)
    })
    this.pending.add(operation)
    await operation
  }

  /** Stop admission, abort body/auth work, and await every started storage operation. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const controller of this.controllers) controller.abort(new HttpFailure(503, 'COLLECTOR_UNAVAILABLE', 'The collector is shutting down; a started write may still commit.'))
    await Promise.allSettled(this.pending)
  }

  private send(
    res: ServerResponse, status: number, contentType: string, bytes: string | Uint8Array, extra: Record<string, string> = {},
  ): void {
    if (res.destroyed || res.writableEnded) return
    const size = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength
    if (size > this.config.maxResponseBytes && contentType !== 'application/octet-stream') throw new HttpFailure(413, 'COLLECTOR_QUOTA', 'The complete response exceeds its byte budget; request a smaller page.')
    res.writeHead(status, { ...headers, 'content-type': contentType, 'content-length': String(size), ...extra })
    res.end(bytes)
  }

  private json(res: ServerResponse, status: number, value: unknown): void { this.send(res, status, 'application/json; charset=utf-8', JSON.stringify(value)) }

  private failure(res: ServerResponse, cause: unknown): void {
    let failure: HttpFailure
    if (cause instanceof HttpFailure) failure = cause
    else if (cause instanceof CollectorError) {
      const statuses = {
        COLLECTOR_INPUT: 400, COLLECTOR_CONFLICT: 409, COLLECTOR_QUOTA: 413, COLLECTOR_STORAGE: 503,
        COLLECTOR_AUTH: 401, COLLECTOR_REVOKED: 403, COLLECTOR_UNAVAILABLE: 503,
      }
      const messages = { COLLECTOR_INPUT: 'The upload is invalid.', COLLECTOR_CONFLICT: 'The record conflicts with committed content.', COLLECTOR_QUOTA: 'The collector byte or item quota was exceeded.', COLLECTOR_STORAGE: 'Durable storage did not confirm the operation; retry the exact upload.', COLLECTOR_AUTH: 'A valid course ingestion credential is required.', COLLECTOR_REVOKED: 'This installation is revoked.', COLLECTOR_UNAVAILABLE: 'The collector dependency is unavailable.' }
      failure = new HttpFailure(statuses[cause.code], cause.code, messages[cause.code])
    } else {
      this.ctx.logger.warn('trajectory collector HTTP dependency failed; uploaded content and credential errors were not logged')
      failure = new HttpFailure(503, 'COLLECTOR_UNAVAILABLE', 'The collector could not confirm the operation; retry the exact upload.')
    }
    this.json(res, failure.status, { error: { code: failure.code, message: failure.message } })
  }

  private instructor(req: IncomingMessage): void {
    const connection = this.ctx.get('connection')
    if (connection === undefined) throw new HttpFailure(503, 'COLLECTOR_UNAVAILABLE', 'Instructor authentication is not configured.')
    const rejection = connection.requestRejection(req)
    if (rejection !== undefined) throw new HttpFailure(rejection, 'COLLECTOR_AUTH', 'Instructor authentication or request trust is required.')
  }

  private async identity(req: IncomingMessage, signal: AbortSignal): Promise<CollectorIdentity> {
    const auth = this.ctx.get('trajectoryUploadAuth')
    if (auth === undefined) throw new HttpFailure(503, 'COLLECTOR_UNAVAILABLE', 'Course ingestion authentication is not configured; uploads are disabled.')
    const identity = await auth.authenticate(req.headers.authorization, signal)
    signal.throwIfAborted()
    if (await this.ctx.trajectoryCollector.isRevoked(identity.installationId)) throw new CollectorError('COLLECTOR_REVOKED', 'Installation revoked.')
    signal.throwIfAborted()
    return identity
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    const url = new URL(String(req.url), 'http://collector.invalid')
    const { config } = this
    if (config.serveRoot && url.pathname === '/') {
      const connection = this.ctx.get('connection')
      if (connection === undefined) throw new HttpFailure(503, 'COLLECTOR_UNAVAILABLE', 'Instructor authentication is not configured.')
      if (connection.requestRejection(req) === 403) throw new HttpFailure(403, 'COLLECTOR_AUTH', 'Instructor request trust is required.')
      for (const [key, value] of Object.entries(headers)) res.setHeader(key, value)
      if (!connection.authorizeIndex(req, res)) return
      if (req.method !== 'GET') { this.send(res, 405, 'text/plain; charset=utf-8', 'Use GET for instructor login.', { allow: 'GET' }); return }
      this.send(res, 303, 'text/plain; charset=utf-8', '', { location: config.dashboardPath })
      return
    }
    if (url.pathname === `${config.path}/records` && req.method === 'POST') {
      const identity = await this.identity(req, signal)
      if (url.search) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Upload query parameters are not accepted.')
      if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') throw new HttpFailure(415, 'COLLECTOR_ENCODING', 'Use application/json for complete records.')
      const value = record(await body(req, config.maxRecordBytes, signal))
      signal.throwIfAborted()
      const receipt = await this.ctx.trajectoryCollector.append(identity, value)
      signal.throwIfAborted()
      this.json(res, 200, receipt)
      return
    }
    if (url.pathname === `${config.path}/artifacts` && req.method === 'POST') {
      const identity = await this.identity(req, signal)
      if (url.search) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Upload query parameters are not accepted.')
      if (req.headers['content-type'] !== 'application/octet-stream') throw new HttpFailure(415, 'COLLECTOR_ENCODING', 'Use application/octet-stream for complete artifacts.')
      const metadata = artifactHeaders(req)
      const data = await body(req, config.maxArtifactBytes, signal)
      signal.throwIfAborted()
      const id = await this.ctx.trajectoryCollector.putArtifact(identity, { ...metadata, data })
      signal.throwIfAborted()
      this.json(res, 200, { id })
      return
    }
    this.instructor(req)
    if (req.method !== 'GET') { this.send(res, 405, 'application/json', '{"error":{"code":"COLLECTOR_METHOD","message":"Use GET for inspection or POST for ingestion."}}', { allow: url.pathname === `${config.path}/status` || url.pathname === config.dashboardPath ? 'GET' : 'GET, POST' }); return }
    if (url.pathname === `${config.path}/records` || url.pathname === config.dashboardPath) {
      const page = await this.ctx.trajectoryCollector.read(query(url, config))
      signal.throwIfAborted()
      if (url.pathname === config.dashboardPath) {
        const serialized = escape(JSON.stringify(page, null, 2))
        this.send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html lang="en"><meta charset="utf-8"><title>Trajectory collector</title><h1>Trajectory collector</h1><p>Read-only complete record page. Change the after, limit, or exact identity filters in the URL to inspect another page.</p><pre>${serialized}</pre></html>`)
      } else this.json(res, 200, page)
      return
    }
    if (url.pathname === `${config.path}/status`) {
      if (url.search) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Status query parameters are not accepted.')
      const status = await this.ctx.trajectoryCollector.status()
      signal.throwIfAborted()
      this.json(res, 200, status)
      return
    }
    const selector = artifactSelector(url)
    const artifact = await this.ctx.trajectoryCollector.getArtifact(selector.installation, selector.id)
    signal.throwIfAborted()
    if (artifact === undefined) throw new HttpFailure(404, 'COLLECTOR_NOT_FOUND', 'The artifact was not found in that installation.')
    if (artifact.data.byteLength > config.maxArtifactBytes) throw new HttpFailure(413, 'COLLECTOR_QUOTA', 'The complete artifact exceeds the download byte budget.')
    const filename = encodeURIComponent(artifact.name).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`)
    this.send(res, 200, 'application/octet-stream', artifact.data, { 'content-disposition': `attachment; filename="trajectory-artifact.bin"; filename*=UTF-8''${filename}` })
  }
}
