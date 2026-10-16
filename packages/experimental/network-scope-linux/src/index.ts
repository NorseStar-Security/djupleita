/** Read-only adapter for the instructor-owned Linux network namespace gateway. */
import { request } from 'node:http'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NetworkScopePolicy, NetworkScopeError } from '@deepseek-ai/dsh-experimental-network-scope'
import type { ScopeInspection, ScopeTarget } from '@deepseek-ai/dsh-experimental-network-scope/types'
import { decodeInspection } from './protocol.ts'

/** Gateway socket location and bounded local inspection budgets. */
export interface Config {
  /** Absolute path to the instructor-owned read-only Unix inspection endpoint. */
  socketPath: string
  /** Whole inspection deadline, including the complete response body, in milliseconds. */
  timeoutMs: number
  /** Maximum accepted JSON response body bytes before closing the connection. */
  maxResponseBytes: number
}

/** A plugin provider, not a firewall installer or a remote-browser security boundary. */
export default class LinuxNetworkScopePolicy extends NetworkScopePolicy {
  static Config = z.object({
    socketPath: z.transform(z.string(), (value) => {
      if (!isAbsolute(value)) throw new Error('network scope socketPath must be absolute')
      return value
    }).default('/run/course-public/control.sock'),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(3000),
    maxResponseBytes: z.natural().min(1).default(2 * 1024 * 1024),
  })

  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<ScopeInspection>>()
  private identity: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.pending)
    })
  }

  override async inspect(after: number | undefined, targets: readonly ScopeTarget[], signal: AbortSignal): Promise<ScopeInspection> {
    const combined = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)])
    combined.throwIfAborted()
    const body = JSON.stringify({ after: after ?? null, targets })
    if (Buffer.byteLength(body) > 32768) throw new NetworkScopeError('SCOPE_INVALID_RESPONSE')
    let closed: Promise<void> = Promise.resolve()
    const task = new Promise<ScopeInspection>((resolve, reject) => {
      const req = request({ socketPath: this.config.socketPath, path: '/inspect', method: 'POST', signal: combined, agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
        const chunks: Buffer[] = []
        let bytes = 0
        response.on('error', reject)
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > this.config.maxResponseBytes) {
            req.destroy(new NetworkScopeError('SCOPE_INVALID_RESPONSE'))
          } else chunks.push(chunk)
        })
        response.on('end', () => {
          try {
            if (response.statusCode !== 200) throw new NetworkScopeError('SCOPE_UNAVAILABLE')
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const inspection = decodeInspection(value, after)
            const identity = `${inspection.instance}:${inspection.policyHash}`
            if (this.identity !== undefined && identity !== this.identity) throw new NetworkScopeError('SCOPE_CHANGED')
            this.identity = identity
            resolve(inspection)
          } catch (cause) { reject(cause instanceof NetworkScopeError ? cause : new NetworkScopeError('SCOPE_INVALID_RESPONSE', { cause })) }
        })
      })
      closed = new Promise<void>((done) => { req.once('close', done) })
      req.on('error', reject)
      req.end(body)
    }).then(async (inspection) => { await closed; return inspection }, async (cause: unknown) => {
      await closed
      if (cause instanceof NetworkScopeError) throw cause
      if (signal.aborted) throw signal.reason
      throw new NetworkScopeError('SCOPE_UNAVAILABLE', { cause })
    })
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }
}
