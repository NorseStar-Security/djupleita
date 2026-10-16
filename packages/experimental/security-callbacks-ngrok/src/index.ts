/** ngrok Agent API tunnel provider; the operator owns agent installation and credentials. */
import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CallbackError, CallbackTunnel } from '@deepseek-ai/dsh-experimental-security-callbacks'
import type { CallbackTunnelLease } from '@deepseek-ai/dsh-experimental-security-callbacks/types'

/** Operator-selected ngrok agent, public endpoint, and API budgets. */
export interface Config {
  /** Local ngrok Agent API root, including /api. */
  agentApi: string
  /** HTTPS origin allocated to this agent in the operator's ngrok account. */
  publicUrl: string
  /** Deadline for each API request, including rollback and deletion. */
  timeoutMs: number
  /** Maximum Agent API response bytes. */
  maxApiBytes: number
}

/** ngrok implementation of the replaceable callbackTunnel Service. */
export default class NgrokCallbackTunnel extends CallbackTunnel {
  static Config: z<Partial<Config>, Config> = z.object({
    agentApi: z.transform(z.string(), (value) => {
      const url = new URL(value)
      if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !/^\/api\/?$/.test(url.pathname)) throw new Error('agentApi must be a loopback HTTP /api URL')
      return url.href.replace(/\/$/, '')
    }).default('http://127.0.0.1:4040/api'),
    publicUrl: z.transform(z.string(), (value) => {
      const url = new URL(value)
      if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('publicUrl must be an HTTPS origin allocated to the ngrok account')
      return url.origin
    }),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(10000),
    maxApiBytes: z.natural().min(512).default(65536),
  })

  constructor(ctx: Context, private readonly config: Config) { super(ctx) }

  override async open(localUrl: string, signal: AbortSignal): Promise<CallbackTunnelLease> {
    signal.throwIfAborted()
    const name = `dsh-callback-${randomBytes(16).toString('hex')}`
    const path = `/endpoints/${name}`
    let closed = false
    const close = async () => {
      if (closed) return
      try { await this.request(path, 'DELETE') } catch (error) {
        throw new CallbackError('CALLBACK_CLEANUP', 'ngrok endpoint removal is unconfirmed. Check the local agent before reloading.', { cause: error })
      }
      closed = true
    }
    try {
      await this.request('/endpoints', 'POST', signal, { name, url: this.config.publicUrl, upstream: { url: localUrl }, inspect: false, pooling_enabled: false })
      signal.throwIfAborted()
      return { url: this.config.publicUrl, close }
    } catch (error) {
      // A failed or cancelled POST can still have created the named endpoint remotely.
      try { await close() } catch (cleanupError) {
        throw new CallbackError('CALLBACK_CLEANUP', 'ngrok publication failed and endpoint removal is unconfirmed. Check the local ngrok agent before retrying.', { cause: new AggregateError([error, cleanupError]) })
      }
      if (error instanceof Error && ['AbortError', 'TimeoutError', 'TypeError'].includes(error.name)) {
        throw new CallbackError('CALLBACK_CLEANUP', 'ngrok publication was interrupted. Removal was attempted, but a late remote creation cannot be excluded; check the local agent.', { cause: error })
      }
      throw new CallbackError('CALLBACK_UNAVAILABLE', 'ngrok could not publish callbacks. Check the running agent, allocated publicUrl, and account limits.', { cause: error })
    }
  }

  private async request(path: string, method: 'POST' | 'DELETE', signal?: AbortSignal, body?: object): Promise<string> {
    const deadline = AbortSignal.timeout(this.config.timeoutMs)
    const response = await fetch(`${this.config.agentApi}${path}`, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}),
    })
    if (method === 'DELETE' && response.status === 404) { await response.body?.cancel(); return '' }
    if (response.status !== (method === 'POST' ? 201 : 204)) {
      await response.body?.cancel()
      throw new CallbackError('CALLBACK_UNAVAILABLE', `ngrok Agent API returned HTTP ${response.status}; check the agent configuration.`)
    }
    const chunks: Uint8Array[] = []
    let size = 0
    if (response.body) {
      for await (const chunk of response.body) {
        size += chunk.byteLength
        if (size > this.config.maxApiBytes) throw new CallbackError('CALLBACK_LIMIT', 'ngrok Agent API response exceeded maxApiBytes.')
        chunks.push(chunk)
      }
    }
    return Buffer.concat(chunks).toString('utf8')
  }
}
