/** Real YAML composition; only the external ngrok agent is replaced. */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Projections from '@deepseek-ai/dsh-session-projection'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import SecurityCallbacks, { CallbackTunnel, type Config } from '@deepseek-ai/dsh-experimental-security-callbacks'
import type { CallbackHandle, CallbackOwner } from '@deepseek-ai/dsh-experimental-security-callbacks/types'
import * as CallbackTools from '@deepseek-ai/dsh-experimental-security-callbacks-tools'
import NgrokCallbackTunnel from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const results = await Promise.allSettled(cleanups.splice(0).reverse().map(cleanup => cleanup()))
  const errors: unknown[] = results.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
  if (errors.length) throw new AggregateError(errors, 'callback fixture teardown failed')
})
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing fixture listener')
  cleanups.push(async () => {
    const closed = new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
    server.closeAllConnections()
    await closed
  })
  return `http://127.0.0.1:${address.port}`
}

interface AgentBehavior {
  post?: number
  empty?: boolean
  delete?: number
  delayMs?: number
  timeoutMs?: number
  oversized?: boolean
}
async function composition(config: Partial<Config> = {}, behavior: AgentBehavior = {}, custom = false) {
  let upstream = ''
  const requests: { method: string; path: string; body: Record<string, unknown> }[] = []
  const agentApi = await listen(createServer((req, res) => {
    const task = async () => {
      const chunks: Buffer[] = []
      for await (const chunk of req) {
        const value: unknown = chunk
        if (!(value instanceof Buffer)) throw new Error('expected HTTP bytes')
        chunks.push(value)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>
      requests.push({ method: req.method!, path: req.url!, body })
      if (req.method === 'POST') {
        upstream = (body.upstream as { url: string }).url
        if (behavior.delayMs) await new Promise(resolve => setTimeout(resolve, behavior.delayMs))
        res.writeHead(behavior.post ?? 201, { 'Content-Type': 'application/json' }).end(behavior.oversized ? 'x'.repeat(70000) : behavior.empty ? '' : JSON.stringify({ name: body.name, url: 'https://callbacks.example.test' }))
      } else res.writeHead(behavior.delete ?? 204).end()
    }
    void task().catch((error: unknown) => res.destroy(error instanceof Error ? error : new Error(String(error))))
  }))
  const root = await mkdtemp(join(tmpdir(), 'callback-loader-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  class CustomTunnel extends CallbackTunnel {
    override async open(localUrl: string) {
      upstream = localUrl
      return { url: 'https://custom.example.test', close: async () => {} }
    }
  }
  Object.assign(ctx.loader.builtins, { include: Include, ngrok: NgrokCallbackTunnel, custom: CustomTunnel, receiver: SecurityCallbacks,
    consumer: CallbackTools, tools: Tools, prompt: SystemPrompt, sessions: Sessions, projections: Projections })
  const file = join(root, 'cordis.yml')
  await writeFile(file, `
- id: tunnel
  name: cordis:${custom ? 'custom' : 'ngrok'}
  config:
    agentApi: ${agentApi}/api
    publicUrl: https://callbacks.example.test
    timeoutMs: ${behavior.timeoutMs ?? 10000}
- id: receiver
  name: cordis:receiver
  config: ${JSON.stringify(config)}
- name: cordis:prompt
- name: cordis:tools
- name: cordis:sessions
- name: cordis:projections
- id: consumer
  name: cordis:consumer
`)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  const owner = brandString<CallbackOwner>('session-one')
  const signal = new AbortController().signal
  const create = () => ctx.securityCallbacks.create(owner, signal)
  const send = (handle: CallbackHandle, body = 'test', suffix = '') => fetch(`${upstream}${new URL(handle.url).pathname}${suffix}`, { method: 'POST', body })
  const dispose = (id: string) => [...ctx.loader.entries()].find(entry => entry.options.id === id)!.fiber!.dispose()
  return { ctx, owner, create, signal, send, requests, dispose, root, upstream: () => upstream }
}

describe('security callbacks through YAML Loader composition', () => {
  it('captures correlated evidence, isolates owners, revokes URLs and shares one tunnel', async () => {
    const { ctx, owner, create, send, requests } = await composition()
    const [first, second] = await Promise.all([create(), create()])
    expect(first.id).not.toBe(second.id)
    expect(requests.filter(request => request.method === 'POST')).toHaveLength(1)
    expect(requests[0]!.body).toMatchObject({ url: 'https://callbacks.example.test', inspect: false, pooling_enabled: false })
    expect((await send(first, 'payload', '/evidence?marker=1')).status).toBe(204)
    const evidence = ctx.securityCallbacks.read(owner, first.id)
    expect(evidence.events).toHaveLength(1)
    expect(evidence.events[0]).toMatchObject({ method: 'POST', bodyBase64: Buffer.from('payload').toString('base64'), path: `/c/${first.id}/evidence?marker=1` })
    expect(ctx.securityCallbacks.read(owner, second.id).events).toEqual([])
    expect(() => ctx.securityCallbacks.read(brandString<CallbackOwner>('another'), first.id)).toThrow('CALLBACK_NOT_FOUND')
    expect(() => { ctx.securityCallbacks.close(brandString<CallbackOwner>('another'), first.id) }).toThrow('CALLBACK_NOT_FOUND')
    ctx.securityCallbacks.close(owner, first.id)
    expect((await send(first)).status).toBe(404)
    expect(() => ctx.securityCallbacks.read(owner, first.id)).toThrow('CALLBACK_NOT_FOUND')
  })

  it('supports a different tunnel provider through the same YAML service injection', async () => {
    const { ctx, owner, create, send, requests } = await composition({}, {}, true)
    const handle = await create()
    expect(handle.url).toMatch(/^https:\/\/custom.example.test\//)
    expect((await send(handle)).status).toBe(204)
    expect(ctx.securityCallbacks.read(owner, handle.id).events).toHaveLength(1)
    expect(requests).toEqual([])
  })

  it('bounds callbacks, events, request bytes and complete evidence including Unicode', async () => {
    const { ctx, owner, create, send } = await composition({ maxCallbacks: 1, maxEvents: 1, maxRequestBytes: 512, maxEvidenceBytes: 2048 })
    const handle = await create()
    await expect(create()).rejects.toHaveProperty('code', 'CALLBACK_LIMIT')
    expect((await send(handle, '💡'.repeat(130))).status).toBe(413)
    expect((await send(handle, '💡')).status).toBe(204)
    expect((await send(handle)).status).toBe(429)
    const evidence = ctx.securityCallbacks.read(owner, handle.id)
    expect(evidence.dropped).toBe(2)
    expect(evidence.events).toHaveLength(1)
    expect(Buffer.byteLength(JSON.stringify(evidence))).toBeLessThanOrEqual(2048)
    expect(Buffer.from(evidence.events[0]!.bodyBase64, 'base64').toString()).toBe('💡')
  })

  it('rejects an oversized single evidence record without silently truncating it', async () => {
    const { ctx, owner, create, send } = await composition({ maxEvidenceBytes: 512 })
    const handle = await create()
    expect((await send(handle, 'x'.repeat(1000))).status).toBe(429)
    expect(ctx.securityCallbacks.read(owner, handle.id)).toMatchObject({ events: [], dropped: 1 })
  })

  it('expires evidence and rejects a caller cancelled before allocation', async () => {
    const { ctx, owner, create, send } = await composition({ ttlMs: 30 })
    const cancelled = AbortSignal.abort()
    await expect(ctx.securityCallbacks.create(owner, cancelled)).rejects.toThrow()
    const handle = await create()
    await expect.poll(() => { try { ctx.securityCallbacks.read(owner, handle.id); return false } catch { return true } }).toBe(true)
    expect((await send(handle)).status).toBe(404)
  })

  it.each([{ post: 500 }, { post: 200 }])('rolls back a failed publication: %j', async (behavior) => {
    const { create, requests } = await composition({}, behavior)
    await expect(create()).rejects.toHaveProperty('code', 'CALLBACK_UNAVAILABLE')
    expect(requests.map(request => request.method)).toEqual(['POST', 'DELETE'])
  })

  it('accepts the documented 201 creation status without requiring a response body', async () => {
    const { create } = await composition({}, { empty: true })
    expect((await create()).url).toMatch(/^https:\/\/callbacks.example.test\/c\//)
  })

  it('reports an unconfirmed remote cleanup and still closes the local receiver', async () => {
    const { create, dispose, upstream } = await composition({}, { delete: 500 })
    await create()
    // Cordis reports disposer errors through its error channel; verify the local effect too.
    await dispose('receiver')
    await expect(fetch(upstream())).rejects.toThrow()
  })

  it('bounds Agent API response bytes and compensates failed publication', async () => {
    const { create, requests } = await composition({}, { oversized: true })
    await expect(create()).rejects.toHaveProperty('code', 'CALLBACK_UNAVAILABLE')
    expect(requests.map(request => request.method)).toEqual(['POST', 'DELETE'])
  })

  it('reports unknown remote effects after an API timeout and attempts deletion', async () => {
    const { create, requests } = await composition({}, { delayMs: 150, timeoutMs: 50 })
    await expect(create()).rejects.toHaveProperty('code', 'CALLBACK_CLEANUP')
    expect(requests.map(request => request.method)).toEqual(['POST', 'DELETE'])
  })

  it('makes provider cleanup idempotent and reports failure with a structured code', async () => {
    const { ctx, signal, requests } = await composition()
    const lease = await ctx.callbackTunnel.open('http://127.0.0.1:8787', signal)
    await lease.close()
    await lease.close()
    expect(requests.filter(request => request.method === 'DELETE')).toHaveLength(1)
    const fixture = await composition({}, { delete: 500 })
    const failedLease = await fixture.ctx.callbackTunnel.open('http://127.0.0.1:8787', signal)
    await expect(failedLease.close()).rejects.toHaveProperty('code', 'CALLBACK_CLEANUP')
  })

  it('deletes only its named endpoint and closes the listener on unload', async () => {
    const { create, dispose, requests, upstream } = await composition()
    await create()
    await dispose('receiver')
    const deletion = requests.find(request => request.method === 'DELETE')!
    expect(deletion.path).toBe(`/api/endpoints/${String(requests[0]!.body.name)}`)
    await expect(fetch(upstream())).rejects.toThrow()
  })

  it('snapshots model-visible tool results and removes tools when the consumer unloads', async () => {
    const { ctx, root, send, dispose } = await composition()
    const signal = new AbortController().signal
    const noAgent = await ctx.tools.execute({ name: 'security_callback_create', arguments: {}, signal, callId: ToolCallId('no-agent') })
    expect(noAgent.isError).toBe(true)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(AgentRegistry)
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(SessionId('callback-agent'), {}, { cwd: root })
    const call = (name: string, args = {}) => ctx.tools.execute({ name, arguments: args, signal, agent, callId: ToolCallId(name) })
    const created = await call('security_callback_create')
    expect(created.isError).toBe(false)
    const text = created.content[0]!
    if (text.type !== 'text') throw new Error('expected callback JSON')
    const handle = JSON.parse(text.text) as CallbackHandle
    await send(handle, 'probe')
    const result = await call('security_callback_read', { id: handle.id })
    expect(result.isError).toBe(false)
    const evidence = result.content[0]!
    if (evidence.type !== 'text') throw new Error('expected evidence JSON')
    const normalized = JSON.parse(evidence.text) as {
      events: { receivedAt: string; headers: object }[]
      url: string
      id: string
      expiresAt: string
    }
    normalized.id = '<callback-id>'; normalized.url = '<callback-url>'; normalized.expiresAt = '<expiry>'
    for (const event of normalized.events) { event.receivedAt = '<received-at>'; event.headers = {}; Object.assign(event, { path: '/c/<callback-id>' }) }
    expect(normalized).toMatchInlineSnapshot(`
      {
        "dropped": 0,
        "events": [
          {
            "bodyBase64": "cHJvYmU=",
            "headers": {},
            "method": "POST",
            "path": "/c/<callback-id>",
            "receivedAt": "<received-at>",
          },
        ],
        "expiresAt": "<expiry>",
        "id": "<callback-id>",
        "url": "<callback-url>",
      }
    `)
    expect((await call('security_callback_close', { id: handle.id })).isError).toBe(false)
    await dispose('consumer')
    for (const suffix of ['create', 'read', 'close']) expect(ctx.tools.get(`security_callback_${suffix}`)).toBeUndefined()
  })

  it('validates agent origins, public URLs, listener addresses, and budgets at configuration load', () => {
    for (const publicUrl of ['http://callback.test', 'https://u:p@callback.test', 'https://callback.test/path']) expect(() => NgrokCallbackTunnel.Config({ publicUrl })).toThrow()
    for (const agentApi of ['https://127.0.0.1/api', 'http://example.test/api', 'http://127.0.0.1/api?x=1']) expect(() => NgrokCallbackTunnel.Config({ publicUrl: 'https://callback.test', agentApi })).toThrow()
    // A configuration document is a parser input; its invalid enum is intentionally untyped here.
    const invalid: Partial<Config> = JSON.parse('{"listenHost":"0.0.0.0"}') as Partial<Config>
    expect(() => SecurityCallbacks.Config(invalid)).toThrow()
    expect(() => SecurityCallbacks.Config({ maxEvents: 0 })).toThrow()
  })
})
