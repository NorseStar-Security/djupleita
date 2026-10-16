import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionToken, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import SessionStore, { Session, SessionId, SESSION_FORMAT_VERSION, pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as SessionModule from '@deepseek-ai/dsh-session'
import LinuxNetworkScopePolicy from '@deepseek-ai/dsh-experimental-network-scope-linux'
import * as Guard from '@deepseek-ai/dsh-experimental-network-scope-guard'
import type { ScopeInspection, ScopeNetworkEvent } from '@deepseek-ai/dsh-experimental-network-scope/types'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'scope fixture cleanup failed')
})

// This fixture exercises the real provider transport and Loader, not Linux
// confinement. Python/Compose tests own the authoritative policy and firewall.
async function composition(pollIntervalMs = 60_000, providerConfig: { timeoutMs?: number; maxResponseBytes?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-nscope-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'g.sock')
  const policyHash = 'a'.repeat(64)
  const events: ScopeNetworkEvent[] = []
  const state = { healthy: true, instance: 'fixture-gateway', firstSeq: 0, requests: 0, active: 0, hang: false, invalid: false,
    status: 200, body: undefined as string | undefined, disconnect: false }
  let arrive: (() => void) | undefined
  const serverErrors: unknown[] = []
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    state.requests++
    state.active++
    response.once('close', () => { state.active-- })
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString()) as { after: number | null; targets: { url: string; method: string }[] }
    arrive?.()
    if (state.hang) return
    if (state.disconnect) { response.destroy(); return }
    const result: ScopeInspection = { protocol: 1, instance: state.instance, policyHash, boundary: 'linux-netns-nftables', uid: 1000,
      healthy: state.healthy, policy: { domains: ['acme.test'], ips: ['198.18.0.2'] }, firstSeq: state.firstSeq, nextSeq: events.length,
      events: input.after === null ? [] : events.slice(Math.max(input.after, state.firstSeq)),
      allowed: input.targets.every(target => new URL(target.url).hostname === 'acme.test'),
    }
    response.statusCode = state.status
    response.end(state.body ?? (state.invalid ? '{}' : JSON.stringify(result)))
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => { serverErrors.push(error); response.destroy() })
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    expect(serverErrors).toEqual([])
  })
  server.listen(socketPath)
  await once(server, 'listening')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'system-prompt': SystemPrompt, tools: ToolRuntime, sessions: SessionStore,
    'scope-linux': LinuxNetworkScopePolicy, 'scope-guard': Guard })
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:system-prompt', '- name: cordis:tools', '- name: cordis:sessions',
    '- id: provider', '  name: cordis:scope-linux', '  config:', `    socketPath: ${JSON.stringify(socketPath)}`,
    `    timeoutMs: ${providerConfig.timeoutMs ?? 1000}`, `    maxResponseBytes: ${providerConfig.maxResponseBytes ?? 2097152}`,
    '- id: guard', '  name: cordis:scope-guard', '  config:', `    pollIntervalMs: ${pollIntervalMs}`, '',
  ].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const effects: string[] = []
  const register = (name: string) => ctx.tools.register(defineTool({ name, description: 'fixture capability',
    parameters: { url: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { effects.push(name); return 'executed' },
  }))
  register('browser_navigate'); register('python'); register('terminal'); register('scanner')
  const run = (name: string, url?: string, agent?: Agent) => ctx.tools.execute({ name, arguments: url === undefined ? {} : { url },
    signal: new AbortController().signal, callId: ToolCallId(`call-${state.requests}`), ...agent === undefined ? {} : { agent } })
  const withAgent = async () => {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    const driver = await mountAgentLoopTestHarness(ctx)
    return driver.create(SessionId('scope-agent'), {}, { cwd: root })
  }
  const append = () => events.push({ seq: events.length, policy: policyHash, time: 'fixture', event: 'denied', transport: 'proxy', host: 'widgets.test' })
  const requestStarted = () => new Promise<void>((resolve) => { arrive = resolve })
  return { ctx, state, effects, run, append, events, requestStarted, withAgent }
}

describe.skipIf(process.platform === 'win32')('network scope plugins through a real Loader and Unix socket', () => {
  it('denies widgets.test before a side effect and leaves opaque capabilities open', async () => {
    const { ctx, run, effects } = await composition()
    expect((await run('browser_navigate', 'https://acme.test')).isError).toBe(false)
    const denied = await run('browser_navigate', 'https://widgets.test')
    expect(denied.isError).toBe(true)
    expect(denied.content[0]).toHaveProperty('text', expect.stringContaining('SCOPE_DENIED'))
    expect((await run('browser_navigate')).isError).toBe(true)
    for (const name of ['python', 'terminal', 'scanner']) expect((await run(name)).isError).toBe(false)
    const status = await run('scope_status')
    expect(status.content[0]).toHaveProperty('text', expect.stringContaining('acme.test'))
    expect(effects).toEqual(['browser_navigate', 'python', 'terminal', 'scanner'])
    // A later permissive waterfall listener cannot override the monotonic judge.
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }))
    expect((await run('browser_navigate', 'https://widgets.test')).isError).toBe(true)
    expect(effects).toHaveLength(4)
  })

  it('fails closed on live unhealthy gateway and requires reload after identity change or audit loss', async () => {
    const { run, state, effects } = await composition()
    expect((await run('python')).isError).toBe(false)
    state.healthy = false
    expect((await run('python')).isError).toBe(true)
    state.healthy = true
    expect((await run('python')).isError).toBe(false)
    state.instance = 'restarted'
    expect((await run('python')).isError).toBe(true)
    state.instance = 'fixture-gateway'
    expect((await run('python')).isError).toBe(true)
    expect(effects).toEqual(['python', 'python'])
  })

  it('records environment events without tool attribution and preserves them in a Session roundtrip', async () => {
    const { ctx, run, append } = await composition()
    const id = SessionId('scope-audit-fixture')
    const events: SessionEvent[] = []
    ctx.on('session/event', (source, event) => { if (source.id === id) events.push(event) })
    const session = ctx.sessions.create(id, { meta: { cwd: '/fixture' } })
    await run('python')
    append()
    await run('terminal')
    const records = events.map(pluginRecordOf).filter(value => value !== undefined)
    expect(records.map(value => value.type)).toEqual(['plugin:network-scope-guard/boundary', 'plugin:network-scope-guard/network'])
    expect(records[1]?.data).toEqual({ instance: 'fixture-gateway', attribution: 'shared-environment',
      event: { seq: 0, time: 'fixture', event: 'denied', policy: 'a'.repeat(64), transport: 'proxy', host: 'widgets.test' } })
    const restored = Session.create(id, JSON.parse(JSON.stringify(events)) as SessionEvent[], {
      version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: '/fixture', isSeeded: false,
    })
    // Restoring an explicit seed adds its own session/end-seed marker.
    expect(restored.seq).toBe(session.seq + 1)
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('blocks rather than silently losing overwritten audit records', async () => {
    const { run, append, state } = await composition()
    await run('python')
    append(); append(); state.firstSeq = 1
    expect((await run('python')).isError).toBe(true)
    state.firstSeq = 0
    expect((await run('python')).isError).toBe(true)
  })

  it('aborts an in-flight provider request and drains polling during unload', async () => {
    const { ctx, run, state, requestStarted } = await composition(10)
    await run('python')
    state.hang = true
    const started = requestStarted()
    await started
    expect(state.active).toBe(1)
    await ctx.fiber.dispose()
    // Server-side EOF is independently scheduled after the client socket closes.
    await expect.poll(() => state.active).toBe(0)
    expect(ctx.get('networkScope')).toBeUndefined()
  })

  it('removes the tool and dispatch guard on consumer-only reload', async () => {
    const { ctx, run, effects } = await composition()
    expect((await run('browser_navigate', 'https://widgets.test')).isError).toBe(true)
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'guard')
    expect(entry?.fiber).toBeDefined()
    await entry!.fiber!.dispose()
    expect(ctx.tools.get('scope_status')).toBeUndefined()
    // Negative control: removing this consumer removes its pre-dispatch denial.
    // In the course namespace, the external network boundary still remains.
    expect((await run('browser_navigate', 'https://widgets.test')).isError).toBe(false)
    expect(effects).toEqual(['browser_navigate'])
    await ctx.plugin(Guard, Guard.Config({ pollIntervalMs: 60_000, targetTools: [{ name: 'browser_navigate', urlField: 'url', methodField: 'method' }] }))
    expect((await run('browser_navigate', 'https://widgets.test')).isError).toBe(true)
  })

  it('rejects malformed protocol output and cannot resume without reload', async () => {
    const { state, run, effects } = await composition()
    state.invalid = true
    expect((await run('python')).isError).toBe(true)
    state.invalid = false
    expect((await run('python')).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it('records genuine tool-linked judge decisions for a production Agent', async () => {
    const { ctx, run, withAgent } = await composition()
    const events: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) })
    const agent = await withAgent()
    expect((await run('python', undefined, agent)).isError).toBe(false)
    expect((await run('browser_navigate', 'https://widgets.test', agent)).isError).toBe(true)
    const decisions = events.map(pluginRecordOf).filter(record => record?.type === 'plugin:network-scope-guard/judge')
    expect(decisions.map(record => record?.data)).toEqual([
      { callId: 'call-0', tool: 'python', allowed: true, code: 'SCOPE_READY' },
      { callId: 'call-1', tool: 'browser_navigate', allowed: false, code: 'SCOPE_DENIED' },
    ])
  })

  it('stops dispatch after a judge audit write fails, even when storage later recovers', async () => {
    const { run, effects, withAgent } = await composition()
    const agent = await withAgent()
    await run('python', undefined, agent)
    const failing = vi.spyOn(SessionModule, 'appendPluginRecord').mockImplementationOnce(() => { throw new Error('fixture write failure') })
    expect((await run('python', undefined, agent)).isError).toBe(true)
    failing.mockRestore()
    expect((await run('python', undefined, agent)).isError).toBe(true)
    expect(effects).toEqual(['python'])
  })

  it('stops dispatch if both the environment audit and its degradation report cannot be written', async () => {
    const { ctx, run, effects } = await composition()
    ctx.sessions.create(SessionId('failed-storage'))
    const failing = vi.spyOn(SessionModule, 'appendPluginRecord').mockImplementation(() => { throw new Error('fixture storage unavailable') })
    expect((await run('python')).isError).toBe(true)
    failing.mockRestore()
    expect((await run('python')).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it('denies if a preceding listener skips scope preflight entirely', async () => {
    const { ctx, run, effects } = await composition()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect((await run('python')).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it('rejects duplicate mappings before mounting a consumer', async () => {
    const { ctx } = await composition()
    const target = { name: 'browser_navigate', urlField: 'url', methodField: 'method' }
    expect(() => { Guard.apply(ctx, { pollIntervalMs: 1000, targetTools: [target, target] }) }).toThrow('duplicate names')
    expect(() => LinuxNetworkScopePolicy.Config({ socketPath: './relative' })).toThrow('must be absolute')
  })

  it('cannot expose cached policy before the first successful preflight', async () => {
    const { ctx } = await composition()
    const execution: ToolRunContext = { name: 'scope_status', arguments: {}, signal: new AbortController().signal,
      callId: ToolCallId('direct-status'), rootCallId: ToolCallId('direct-status'), token: Symbol('fixture') as ToolExecutionToken,
      deferContext() {}, concludeTurn() {},
    }
    await expect(ctx.tools.get('scope_status')!.execute({}, execution)).rejects.toHaveProperty('code', 'SCOPE_UNAVAILABLE')
  })

  it('rejects non-object arguments and non-string target methods without dispatch', async () => {
    const { ctx, effects } = await composition()
    for (const args of [null, { url: 'https://acme.test', method: 17 }]) {
      const result = await ctx.tools.execute({ name: 'browser_navigate', arguments: args,
        signal: new AbortController().signal, callId: ToolCallId('invalid-target') })
      expect(result.isError).toBe(true)
      expect(result.content[0]).toHaveProperty('text', expect.stringContaining('SCOPE_INVALID_TARGET'))
    }
    expect(effects).toEqual([])
  })

  it('contains unexpected provider failures and records unavailability', async () => {
    const { ctx, run, effects } = await composition()
    const events: SessionEvent[] = []
    ctx.sessions.create(SessionId('transport-failure'))
    ctx.on('session/event', (_session, event) => { events.push(event) })
    const failing = vi.spyOn(ctx.networkScope, 'inspect').mockRejectedValueOnce(new Error('fixture transport failure'))
    expect((await run('python')).isError).toBe(true)
    expect(events.map(pluginRecordOf).filter(record => record?.type === 'plugin:network-scope-guard/unavailable')
      .map(record => record?.data)).toEqual([{ code: 'SCOPE_UNAVAILABLE' }])
    failing.mockRestore()
    expect((await run('python')).isError).toBe(false)
    expect(effects).toEqual(['python'])
  })

  it('observes background gateway failure and recovers only after a successful inspection', async () => {
    const { run, state } = await composition(10)
    state.healthy = false
    await expect.poll(() => state.requests).toBeGreaterThan(0)
    expect((await run('python')).isError).toBe(true)
    state.healthy = true
    expect((await run('python')).isError).toBe(false)
  })

  it('cancels a caller-owned preflight without degrading the environment', async () => {
    const { ctx, run, state, requestStarted } = await composition()
    state.hang = true
    const controller = new AbortController()
    const started = requestStarted()
    const pending = ctx.tools.execute({ name: 'python', arguments: {}, signal: controller.signal, callId: ToolCallId('cancel-preflight') })
    await started
    controller.abort(new Error('fixture caller cancelled'))
    expect((await pending).isError).toBe(true)
    state.hang = false
    expect((await run('python')).isError).toBe(false)
  })

  it('drains a caller preflight during disposal without reporting a new environment failure', async () => {
    const { ctx, state, requestStarted } = await composition()
    state.hang = true
    const started = requestStarted()
    const pending = ctx.tools.execute({ name: 'python', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('unload-preflight') })
    await started
    await ctx.fiber.dispose()
    expect((await pending).isError).toBe(true)
    await expect.poll(() => state.active).toBe(0)
  })

  it('rejects non-success, malformed JSON, oversized responses, and disconnected transports', async () => {
    const { ctx, state } = await composition(60_000, { maxResponseBytes: 512 })
    const inspect = () => ctx.networkScope.inspect(undefined, [], new AbortController().signal)
    state.status = 503
    await expect(inspect()).rejects.toHaveProperty('code', 'SCOPE_UNAVAILABLE')
    state.status = 200
    state.body = '{'
    await expect(inspect()).rejects.toHaveProperty('code', 'SCOPE_INVALID_RESPONSE')
    state.body = 'x'.repeat(513)
    await expect(inspect()).rejects.toHaveProperty('code', 'SCOPE_INVALID_RESPONSE')
    state.body = undefined
    state.disconnect = true
    await expect(inspect()).rejects.toHaveProperty('code', 'SCOPE_UNAVAILABLE')
    state.disconnect = false
    await expect(inspect()).resolves.toHaveProperty('healthy', true)
    await expect(ctx.networkScope.inspect(undefined, [{ url: 'x'.repeat(32768), method: 'GET' }], new AbortController().signal))
      .rejects.toHaveProperty('code', 'SCOPE_INVALID_RESPONSE')
  })

  it('bounds the full request lifetime and leaves no active request after timeout', async () => {
    const { ctx, state } = await composition(60_000, { timeoutMs: 200 })
    state.hang = true
    await expect(ctx.networkScope.inspect(undefined, [], new AbortController().signal)).rejects.toHaveProperty('code', 'SCOPE_UNAVAILABLE')
    await expect.poll(() => state.active).toBe(0)
  })
})
