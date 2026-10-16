/** HTTP callback receiver with session isolation and a replaceable public tunnel. */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { CallbackEvidence, CallbackHandle, CallbackId, CallbackOwner, CallbackTunnelLease } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    securityCallbacks: SecurityCallbacks
    callbackTunnel: CallbackTunnel
  }
}

/** Structured callback failures; provider diagnostics and credentials are not forwarded. */
export class CallbackError extends Error {
  constructor(readonly code: 'CALLBACK_UNAVAILABLE' | 'CALLBACK_NOT_FOUND' | 'CALLBACK_LIMIT' | 'CALLBACK_CLEANUP', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'CallbackError'
  }
}

/** Public tunnel Service Definition, replaceable by ordinary Cordis plugins. */
export abstract class CallbackTunnel extends Service {
  constructor(ctx: Context) { super(ctx, 'callbackTunnel') }
  /**
   * Publish only the supplied HTTP receiver. Roll back failures before rejecting.
   * @param localUrl - receiver's local HTTP origin, never a Harness UI address.
   * @param signal - provider lifetime cancellation; failed publication must be cleaned up.
   * @returns an HTTPS origin and an idempotent, awaited remote cleanup operation.
   */
  abstract open(localUrl: string, signal: AbortSignal): Promise<CallbackTunnelLease>
}

/** Receiver resource budgets; every deployment choice is configurable in cordis.yml. */
export interface Config {
  /** Loopback listener address; the tunnel agent must share this network namespace. */
  listenHost: '127.0.0.1' | '::1'
  /** Zero assigns an unused port. */
  listenPort: number
  /** Lifetime of each correlation URL, in milliseconds. */
  ttlMs: number
  /** Maximum live correlation URLs across sessions. */
  maxCallbacks: number
  /** Maximum retained requests per URL. */
  maxEvents: number
  /** Maximum incoming body and header bytes, independently. */
  maxRequestBytes: number
  /** Maximum complete serialized evidence result per URL. */
  maxEvidenceBytes: number
  /** Deadline for one inbound HTTP request. */
  requestTimeoutMs: number
  /** Maximum simultaneous inbound connections. */
  maxConnections: number
}

interface Entry {
  owner: CallbackOwner
  evidence: CallbackEvidence
  timer: ReturnType<typeof setTimeout>
}
interface Receiver {
  server: Server
  lease: CallbackTunnelLease
}

/** Shared receiver; unknown and expired URLs never expose evidence or other services. */
export default class SecurityCallbacks extends Service {
  static inject = ['callbackTunnel']
  static Config: z<Partial<Config>, Config> = z.object({
    listenHost: z.union(['127.0.0.1', '::1']).default('127.0.0.1'),
    listenPort: z.natural().max(65535).default(0),
    ttlMs: z.natural().min(1).max(2_147_483_647).default(600000),
    maxCallbacks: z.natural().min(1).default(32),
    maxEvents: z.natural().min(1).default(32),
    maxRequestBytes: z.natural().min(1).default(16384),
    maxEvidenceBytes: z.natural().min(512).default(131072),
    maxConnections: z.natural().min(1).default(32),
    requestTimeoutMs: z.natural().min(1).max(2_147_483_647).default(10000),
  })

  private readonly entries = new Map<CallbackId, Entry>()
  private readonly lifetime = new AbortController()
  private receiver?: Promise<Receiver>

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'securityCallbacks')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      for (const entry of this.entries.values()) clearTimeout(entry.timer)
      this.entries.clear()
      if (!this.receiver) return
      let receiver: Receiver
      try { receiver = await this.receiver } catch (error) {
        // Failed initialization owns and awaits its rollback before rejecting.
        ctx.logger.warn('Callback receiver did not initialize: %s', error)
        return
      }
      await this.shutdown(receiver)
    })
  }

  /**
   * Allocate a correlation URL; the first call starts the dedicated receiver and tunnel.
   * @param owner - initiating consumer identity, kept private from public requests.
   * @param signal - caller cancellation, checked before and after shared initialization.
   * @returns a URL with an unpredictable path and absolute expiration time.
   */
  async create(owner: CallbackOwner, signal: AbortSignal): Promise<CallbackHandle> {
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    this.receiver ??= this.start()
    const { lease } = await this.receiver
    signal.throwIfAborted()
    this.lifetime.signal.throwIfAborted()
    if (this.entries.size >= this.config.maxCallbacks) throw new CallbackError('CALLBACK_LIMIT', 'Close an existing callback or wait for it to expire.')
    const id = brandString<CallbackId>(randomBytes(24).toString('hex'))
    const handle = { id, url: `${lease.url}/c/${id}`, expiresAt: new Date(Date.now() + this.config.ttlMs).toISOString() }
    const evidence = { ...handle, events: [], dropped: 0 }
    if (Buffer.byteLength(JSON.stringify({ ...evidence, dropped: Number.MAX_SAFE_INTEGER })) > this.config.maxEvidenceBytes) throw new CallbackError('CALLBACK_LIMIT', 'The callback URL exceeds maxEvidenceBytes; increase the configured budget.')
    const timer = setTimeout(() => this.entries.delete(id), this.config.ttlMs)
    timer.unref()
    this.entries.set(id, { owner, evidence, timer })
    return handle
  }

  /**
   * Read retained evidence without consuming it; callback traffic is untrusted data.
   * @param owner - identity that created the callback.
   * @param id - correlation handle returned by create.
   * @returns a detached evidence snapshot; unavailable handles fail identically across owners.
   */
  read(owner: CallbackOwner, id: CallbackId): CallbackEvidence {
    return structuredClone(this.entry(owner, id).evidence)
  }

  /**
   * Revoke one URL and discard its in-memory evidence.
   * @param owner - identity that created the callback.
   * @param id - live correlation handle.
   */
  close(owner: CallbackOwner, id: CallbackId): void {
    clearTimeout(this.entry(owner, id).timer)
    this.entries.delete(id)
  }

  private entry(owner: CallbackOwner, id: CallbackId): Entry {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner || Date.parse(entry.evidence.expiresAt) <= Date.now()) {
      throw new CallbackError('CALLBACK_NOT_FOUND', 'Callback unavailable for this session; create a new callback.')
    }
    return entry
  }

  private async start(): Promise<Receiver> {
    const server = createServer({
      connectionsCheckingInterval: this.config.requestTimeoutMs,
      maxHeaderSize: this.config.maxRequestBytes,
      requestTimeout: this.config.requestTimeoutMs,
      headersTimeout: this.config.requestTimeoutMs,
    }, (req, res) => {
      // Request and response errors belong to this connection, never the plugin lifecycle.
      req.on('error', () => req.destroy())
      res.on('error', () => res.destroy())
      void this.receive(req, res).catch((error: unknown) => {
        this.ctx.logger.warn('Callback capture failed: %s', error)
        res.destroy()
      })
    })
    server.maxConnections = this.config.maxConnections
    server.setTimeout(this.config.requestTimeoutMs, socket => socket.destroy())
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.config.listenPort, this.config.listenHost, () => { server.off('error', reject); resolve() })
      })
      server.on('error', (error) => { this.ctx.logger.error('Callback listener failed: %s', error) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new CallbackError('CALLBACK_UNAVAILABLE', 'The callback listener has no TCP port.')
      const host = this.config.listenHost === '::1' ? '[::1]' : this.config.listenHost
      const lease = await this.ctx.callbackTunnel.open(`http://${host}:${address.port}`, this.lifetime.signal)
      const receiver = { server, lease }
      try {
        const url = new URL(lease.url)
        if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('expected an HTTPS origin')
        this.lifetime.signal.throwIfAborted()
        return { server, lease: { url: url.origin, close: () => lease.close() } }
      } catch (error) {
        await this.shutdown(receiver)
        throw error
      }
    } catch (error) {
      await this.closeServer(server)
      if (error instanceof CallbackError && error.code === 'CALLBACK_CLEANUP') throw error
      throw new CallbackError('CALLBACK_UNAVAILABLE', 'Cannot publish callbacks; check the tunnel provider configuration. Reload the plugin after correcting it.', { cause: error })
    }
  }

  private async receive(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/c\/([a-f0-9]{48})(?:\/|\?|$)/.exec(req.url ?? '')
    const token = match?.[1]
    const entry = token === undefined ? undefined : this.entries.get(brandString<CallbackId>(token))
    if (!entry || Date.parse(entry.evidence.expiresAt) <= Date.now()) { res.writeHead(404).end(); req.resume(); return }
    if (entry.evidence.events.length >= this.config.maxEvents) { this.drop(entry); res.writeHead(429).end(); req.resume(); return }
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      bytes += buffer.length
      if (bytes > this.config.maxRequestBytes) { this.drop(entry); res.writeHead(413, { Connection: 'close' }).end(); return }
      chunks.push(buffer)
    }
    if (this.entries.get(entry.evidence.id) !== entry || Date.parse(entry.evidence.expiresAt) <= Date.now()) {
      res.writeHead(404).end()
      return
    }
    const event = { receivedAt: new Date().toISOString(), method: req.method ?? '', path: req.url ?? '',
      headers: Object.fromEntries(Object.entries(req.headers).filter((pair): pair is [string, string | string[]] => pair[1] !== undefined)),
      bodyBase64: Buffer.concat(chunks).toString('base64') }
    const evidence = { ...entry.evidence, events: [...entry.evidence.events, event] }
    // Reserve the maximum counter width so later rejections cannot exceed the result budget.
    const evidenceBytes = Buffer.byteLength(JSON.stringify({ ...evidence, dropped: Number.MAX_SAFE_INTEGER }))
    if (evidence.events.length > this.config.maxEvents || evidenceBytes > this.config.maxEvidenceBytes) {
      this.drop(entry); res.writeHead(429).end(); return
    }
    entry.evidence = evidence
    res.writeHead(204, { 'Cache-Control': 'no-store' }).end()
  }

  private drop(entry: Entry): void {
    entry.evidence = { ...entry.evidence, dropped: Math.min(Number.MAX_SAFE_INTEGER, entry.evidence.dropped + 1) }
  }

  private async closeServer(server: Server): Promise<void> {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => {
      if (error && !('code' in error && error.code === 'ERR_SERVER_NOT_RUNNING')) reject(error)
      else resolve()
    }))
    server.closeAllConnections()
    await closed
  }

  private async shutdown(receiver: Receiver): Promise<void> {
    // Stop accepting bytes locally even if the remote endpoint cannot be removed.
    const results = await Promise.allSettled([this.closeServer(receiver.server), receiver.lease.close()])
    const errors: unknown[] = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
    if (errors.length) throw new CallbackError('CALLBACK_CLEANUP', 'The local receiver stopped; remote endpoint cleanup may be incomplete. Check the tunnel agent before reloading.', { cause: new AggregateError(errors) })
  }
}
