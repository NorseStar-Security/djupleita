import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ActionReviewError } from '@deepseek-ai/dsh-experimental-action-review'
import type { ActionReviewHash, ReviewRequest } from '@deepseek-ai/dsh-experimental-action-review/types'
import LinuxActionReview from '@deepseek-ai/dsh-experimental-action-review-linux'
import LinuxNetworkScope from '@deepseek-ai/dsh-experimental-network-scope-linux'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import SessionStore, { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import * as SessionModule from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as Guard from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'action-review fixture cleanup failed')
})

// External program execution is scripted; the real ToolRuntime owns the outer
// transport and every inner binding's complete policy/guard pipeline.
class FixturePtc extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  starts = 0
  override resolve(input: PtcRunRequest): PtcRunSpec {
    return { ...input, cwd: input.cwd ?? process.cwd(), timeoutMs: input.timeoutMs ?? 1000 }
  }
  override async run(input: PtcRunSpec): Promise<PtcRunResult> {
    this.starts++
    const tool = input.bindings[0]!.functions.mcp__browser__navigate!
    const url = input.program === 'nested-denial' ? 'https://acme.test/quitquitquit' : input.program
    return { logs: [], value: await tool({ url }) }
  }
}

async function composition(config: {
  timeoutMs?: number
  maxResponseBytes?: number
  maxActionBytes?: number
  ptc?: boolean
  missing?: 'review' | 'scope'
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-action-review-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const socketPath = join(root, 'g.sock')
  const state = { policyHash: 'a'.repeat(64), reviewHash: 'b'.repeat(64), instance: 'fixture-gateway', healthy: true, ready: true,
    reviewStatus: 200, body: undefined as string | undefined, hang: false, disconnect: false, receipt: 0, active: 0,
    deny: false, badHash: false, forceAgentlessAllow: false, statusInstance: undefined as string | undefined }
  const actions: ReviewRequest[] = []
  const bytes: string[] = []
  const serverErrors: unknown[] = []
  let arrive: (() => void) | undefined
  let release: (() => void) | undefined
  let blocked: Promise<void> | undefined
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    state.active++
    response.once('close', () => { state.active-- })
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      if (!Buffer.isBuffer(chunk)) throw new Error('fixture request must stream bytes')
      chunks.push(chunk)
    }
    const body = Buffer.concat(chunks).toString('utf8')
    if (request.url === '/inspect') {
      response.end(JSON.stringify({ protocol: 1, instance: state.instance, policyHash: state.policyHash, boundary: 'linux-netns-nftables', uid: 1000,
        healthy: state.healthy, policy: { domains: ['acme.test'] }, firstSeq: 0, nextSeq: 0, events: [], allowed: true }))
      return
    }
    const identity = { protocol: 1, instance: state.instance, policyHash: state.policyHash, reviewHash: state.reviewHash }
    if (request.url === '/review/status') { response.end(JSON.stringify({ ...identity, instance: state.statusInstance ?? state.instance, ready: state.ready })); return }
    if (request.url !== '/review') throw new Error(`unexpected fixture route ${request.url}`)
    const input = JSON.parse(body) as ReviewRequest
    actions.push(input)
    bytes.push(body)
    arrive?.()
    if (blocked !== undefined) await blocked
    if (state.hang) return
    if (state.disconnect) { response.destroy(); return }
    const denied = state.deny || (input.action.sessionId === null && !state.forceAgentlessAllow)
      || JSON.stringify(input.action.arguments).includes('acme.test/quitquitquit')
    // This increment models trusted durable commit, before the acknowledgement.
    state.receipt++
    response.statusCode = state.reviewStatus
    response.end(state.body ?? JSON.stringify({ ...identity, inputHash: state.badHash ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex'),
      decision: denied ? 'deny' : 'allow', code: input.action.sessionId === null ? 'ACTION_CONTEXT_REQUIRED' : denied ? 'ACTION_DENIED' : 'ACTION_ALLOWED',
      findings: [{ evaluator: 'fixture', model: 'fixture-v1', risks: { destructive: denied ? 1 : 0 } }], receipt: state.receipt }))
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => { serverErrors.push(error); response.destroy() })
  })
  cleanups.push(async () => {
    release?.()
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    expect(serverErrors).toEqual([])
  })
  server.listen(socketPath)
  await once(server, 'listening')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, tools: ToolRuntime, sessions: SessionStore, prompt: SystemPrompt,
    'scope-linux': LinuxNetworkScope, 'review-linux': LinuxActionReview, 'review-guard': Guard, ptc: FixturePtc })
  const path = join(root, 'cordis.yml')
  await writeFile(path, ['- name: cordis:prompt', '- name: cordis:tools', '  config:', `    mode: ${config.ptc === true ? 'ptc' : 'native'}`,
    '- name: cordis:sessions', ...config.ptc === true ? ['- name: cordis:ptc'] : [],
    ...config.missing === 'scope' ? [] : ['- id: scope', '  name: cordis:scope-linux', '  config:', `    socketPath: ${JSON.stringify(socketPath)}`],
    ...config.missing === 'review' ? [] : ['- id: provider', '  name: cordis:review-linux', '  config:', `    socketPath: ${JSON.stringify(socketPath)}`,
      `    timeoutMs: ${config.timeoutMs ?? 1000}`, `    maxResponseBytes: ${config.maxResponseBytes ?? 1048576}`,
      `    maxActionBytes: ${config.maxActionBytes ?? 1048576}`],
    '- id: guard', '  name: cordis:review-guard', ''].join('\n'))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(AgentRegistry)
  const driver = await mountAgentLoopTestHarness(ctx)
  const agent = await driver.create(SessionId('research'), {}, { cwd: root })
  const effects: { tool: string; args: unknown; receipt: number }[] = []
  const register = (name: string) => ctx.tools.register(defineTool({ name, description: 'Fixture research capability.',
    parameters: { url: { type: 'string' } }, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { effects.push({ tool: name, args, receipt: state.receipt }); return 'fixture completed' },
  }))
  for (const name of ['terminal', 'mcp__browser__navigate', 'subagent']) register(name)
  let call = 0
  const run = (tool = 'terminal', args: unknown = {}, owner: Agent | null = agent, signal = new AbortController().signal): Promise<ToolExecutionResult> =>
    ctx.tools.execute({ name: tool, arguments: args, callId: ToolCallId(`call-${++call}`), signal, ...owner === null ? {} : { agent: owner } })
  const records = () => agent.session.snapshotEvents().map(pluginRecordOf).filter(record => record !== undefined)
  const hold = () => { blocked = new Promise<void>((resolve) => { release = resolve }) }
  return { ctx, state, actions, bytes, effects, agent, register, run, records, driver, socketPath,
    started: () => new Promise<void>((resolve) => { arrive = resolve }), hold, release: () => { release?.(); blocked = undefined } }
}

describe.skipIf(process.platform === 'win32')('mandatory action review through real Loader and Unix gateway', () => {
  it('records a trusted receipt before native/MCP bodies and pins complete arguments and schema', async () => {
    const { run, effects, actions, records, bytes } = await composition()
    const args = { command: 'curl https://acme.test', nested: ['完整', 1.25, true] }
    expect((await run('terminal', args)).isError).toBe(false)
    expect((await run('mcp__browser__navigate', { url: 'https://acme.test' })).isError).toBe(false)
    expect(effects.map(value => value.receipt)).toEqual([1, 2])
    expect(actions[0]).toMatchObject({ action: { callId: 'call-1', rootCallId: 'call-1', sessionId: 'research', tool: 'terminal', arguments: args,
      schema: { name: 'terminal', description: 'Fixture research capability.' } }, policyHash: 'a'.repeat(64) })
    const decisions = records().filter(record => record.type === 'plugin:action-review-guard/decision')
    expect(decisions[0]?.data).toMatchObject({ allowed: true, review: { receipt: 1, inputHash: createHash('sha256').update(bytes[0]!).digest('hex') } })
    expect(records().map(record => record.type)).toEqual(['plugin:action-review-guard/decision', 'plugin:action-review-guard/result',
      'plugin:action-review-guard/decision', 'plugin:action-review-guard/result'])
  })

  it.each(['review', 'scope'] as const)('installs denial before an initially missing %s provider, then reviews after late load', async (missing) => {
    const { ctx, run, effects, socketPath } = await composition({ missing })
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
    const provider = missing === 'review'
      ? ctx.plugin(LinuxActionReview, LinuxActionReview.Config({ socketPath }))
      : ctx.plugin(LinuxNetworkScope, LinuxNetworkScope.Config({ socketPath }))
    await provider
    expect((await run()).isError).toBe(false)
    await provider.dispose()
    expect((await run()).isError).toBe(true)
    if (missing === 'review') await ctx.plugin(LinuxActionReview, LinuxActionReview.Config({ socketPath }))
    else await ctx.plugin(LinuxNetworkScope, LinuxNetworkScope.Config({ socketPath }))
    expect((await run()).isError).toBe(true)
    expect(effects).toHaveLength(1)
  })

  it('denies an allowed-host destructive operation even after a later listener says allow', async () => {
    const { ctx, run, effects, records } = await composition()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }))
    const result = await run('mcp__browser__navigate', { url: 'https://acme.test/quitquitquit' })
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([{ type: 'text', text: 'Error: Action review denied tool dispatch (ACTION_DENIED).' }])
    expect(effects).toEqual([])
    expect(records()[0]?.data).toMatchObject({ allowed: false, review: { receipt: 1, decision: 'deny' } })
  })

  it('cannot dispatch agentless even if the reviewer incorrectly allows it', async () => {
    const { state, run, actions, effects } = await composition()
    state.forceAgentlessAllow = true
    expect((await run('terminal', {}, null)).isError).toBe(true)
    expect(actions[0]?.action.sessionId).toBeNull()
    expect(state.receipt).toBe(1)
    expect(effects).toEqual([])
  })

  it('reviews outer PTC and each nested MCP call independently with exact parent identity', async () => {
    const { ctx, run, effects, actions } = await composition({ ptc: true })
    expect((await run('run_code', { code: 'https://acme.test', description: 'ordinary request' })).isError).toBe(false)
    expect((await run('run_code', { code: 'https://acme.test/quitquitquit', description: 'forbidden operation' })).isError).toBe(true)
    expect((await run('run_code', { code: 'nested-denial', description: 'inner denial' })).isError).toBe(true)
    expect(actions.map(value => value.action.tool)).toEqual(['run_code', 'mcp__browser__navigate', 'run_code', 'run_code', 'mcp__browser__navigate'])
    expect(actions[1]?.action).toMatchObject({ callId: 'call-1:ptc:1', rootCallId: 'call-1', parentCallId: 'call-1', sessionId: 'research' })
    expect(effects).toHaveLength(1)
    expect((ctx.ptcRuntime as FixturePtc).starts).toBe(2)
  })

  it('guards a production child agent and never shares parent call permits', async () => {
    const { ctx, agent, run, effects, actions } = await composition()
    const child = (await ctx.agents.create({ sessionId: SessionId('child'), parentAgent: agent, meta: { parentSession: agent.session.id } })).agent
    expect((await run('subagent')).isError).toBe(false)
    expect((await run('terminal', { url: 'https://acme.test' }, child)).isError).toBe(false)
    expect((await run('terminal', { url: 'https://acme.test/quitquitquit' }, child)).isError).toBe(true)
    expect(actions.map(value => value.action.sessionId)).toEqual(['research', 'child', 'child'])
    expect(effects).toHaveLength(2)
  })

  it('waits for individual durable acknowledgements before concurrent calls may execute', async () => {
    const { run, hold, started, release, effects, state } = await composition()
    hold()
    const arrived = started()
    const first = run('terminal', { n: 1 })
    const second = run('terminal', { n: 2 })
    await arrived
    expect(effects).toEqual([])
    expect(state.receipt).toBe(0)
    release()
    expect((await Promise.all([first, second])).every(value => !value.isError)).toBe(true)
    expect(effects).toHaveLength(2)
    expect(effects.every(value => value.receipt > 0)).toBe(true)
  })

  it('fails closed on unready or unhealthy services and does not cache an earlier allow', async () => {
    const { run, state, effects } = await composition()
    expect((await run()).isError).toBe(false)
    state.ready = false
    expect((await run()).isError).toBe(true)
    state.ready = true
    state.healthy = false
    expect((await run()).isError).toBe(true)
    state.healthy = true
    expect((await run()).isError).toBe(false)
    expect(effects).toHaveLength(2)
    expect(state.receipt).toBe(2)
  })

  it('closes admission after malformed acknowledgements and never reuses a stale allow', async () => {
    const { run, state, effects } = await composition()
    await run()
    state.badHash = true
    expect((await run()).isError).toBe(true)
    state.badHash = false
    expect((await run()).isError).toBe(true)
    expect(effects).toHaveLength(1)
  })

  it('closes admission after reviewer deployment replacement', async () => {
    const { run, state, effects } = await composition()
    await run()
    state.reviewHash = 'c'.repeat(64)
    expect((await run()).isError).toBe(true)
    state.reviewHash = 'b'.repeat(64)
    expect((await run()).isError).toBe(true)
    expect(effects).toHaveLength(1)
  })

  it('denies a reviewer attached to a different gateway than the fresh scope observation', async () => {
    const { run, state, effects } = await composition()
    state.statusInstance = 'different-gateway'
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it.each(['instance', 'policyHash', 'reviewHash'] as const)('denies a provider whose %s changes between status and receipt', async (field) => {
    const { ctx, run, effects } = await composition()
    const original = ctx.actionReview.review.bind(ctx.actionReview)
    vi.spyOn(ctx.actionReview, 'review').mockImplementationOnce(async (request, signal) => {
      const result = await original(request, signal)
      return { ...result, [field]: field === 'reviewHash' ? brandString<ActionReviewHash>('d'.repeat(64)) : 'd'.repeat(64) }
    })
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it('never authorizes an unknown tool lacking a reviewable schema', async () => {
    const { run, actions, effects, records } = await composition()
    expect((await run('unregistered')).isError).toBe(true)
    expect(actions[0]?.action.schema).toBeUndefined()
    expect(records()[0]?.data).toMatchObject({ allowed: false, code: 'ACTION_REVIEW_INPUT' })
    expect(effects).toEqual([])
  })

  it('rejects a lossy tool schema at the provider serialization boundary', async () => {
    const { ctx, actions } = await composition()
    await expect(ctx.actionReview.review({ policyHash: 'a'.repeat(64), action: { callId: ToolCallId('direct'), rootCallId: ToolCallId('direct'),
      sessionId: SessionId('research'), tool: 'fixture', arguments: {}, schema: { name: 'fixture', description: 'fixture', parameters: { callback: () => {} } } } },
    new AbortController().signal)).rejects.toHaveProperty('code', 'ACTION_REVIEW_INPUT')
    expect(actions).toEqual([])
  })

  it('refuses to execute if Session receipt persistence fails, even after storage recovers', async () => {
    const { run, effects, state } = await composition()
    const failure = vi.spyOn(SessionModule, 'appendPluginRecord').mockImplementationOnce(() => { throw new Error('fixture full disk') })
    expect((await run()).isError).toBe(true)
    failure.mockRestore()
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
    expect(state.receipt).toBe(1)
  })

  it('contains simultaneous decision and final-outcome storage failures without reopening admission', async () => {
    const { run, effects } = await composition()
    const failure = vi.spyOn(SessionModule, 'appendPluginRecord').mockImplementation(() => { throw new Error('fixture unavailable disk') })
    expect((await run()).isError).toBe(true)
    failure.mockRestore()
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it('closes future admission when final dispatch outcome cannot be persisted', async () => {
    const { run, effects } = await composition()
    const original = SessionModule.appendPluginRecord
    const failure = vi.spyOn(SessionModule, 'appendPluginRecord').mockImplementation((...args) => {
      if (args[1] === 'plugin:action-review-guard/result') throw new Error('fixture storage lost after execution')
      return original(...args)
    })
    expect((await run()).isError).toBe(false)
    failure.mockRestore()
    expect((await run()).isError).toBe(true)
    expect(effects).toHaveLength(1)
  })

  it('leaves a mandatory denial latch after consumer-only unload and remount', async () => {
    const { ctx, run, effects } = await composition()
    await run()
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'guard')!
    await entry.fiber!.dispose()
    expect((await run()).isError).toBe(true)
    await ctx.plugin(Guard)
    expect((await run()).isError).toBe(true)
    expect(effects).toHaveLength(1)
  })

  it.each([false, true])('keeps stale and replacement Tools closed after provider removal (consumer already removed: %s)', async (consumerRemoved) => {
    const { ctx, run, effects, register, agent } = await composition()
    const guard = [...ctx.loader.entries()].find(entry => entry.options.id === 'guard')!
    const tools = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:tools')!
    const staleRegistry = ctx.tools
    const call = { name: 'terminal', arguments: {}, agent, signal: new AbortController().signal, callId: ToolCallId('stale-registry') }
    if (consumerRemoved) await guard.fiber!.dispose()
    await tools.fiber!.dispose()
    expect((await staleRegistry.execute(call)).isError).toBe(true)
    const replacement = ctx.plugin(ToolRuntime, { mode: 'native' })
    await replacement.await()
    await ctx.fiber.await()
    register('terminal')
    expect(ctx.tools).not.toBe(staleRegistry)
    const result = await run()
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('Action review admission is closed')
    expect((await staleRegistry.execute(call)).isError).toBe(true)
    if (consumerRemoved) await ctx.plugin(Guard)
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it('aborts in-flight review on consumer unload and drains it before returning', async () => {
    const { ctx, run, state, started, effects } = await composition()
    state.hang = true
    const arrived = started()
    const pending = run()
    await arrived
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'guard')!
    await entry.fiber!.dispose()
    expect((await pending).isError).toBe(true)
    await expect.poll(() => state.active).toBe(0)
    expect(effects).toEqual([])
  })

  it('denies when a preceding listener skips review completely', async () => {
    const { ctx, run, state, effects, records } = await composition()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect((await run()).isError).toBe(true)
    expect(state.receipt).toBe(0)
    expect(effects).toEqual([])
    expect(records()[0]?.data).toMatchObject({ reviewed: false, isError: true })
  })

  it('bounds review latency without allowing a timed-out call', async () => {
    const { run, state, effects } = await composition({ timeoutMs: 20 })
    state.hang = true
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
    await expect.poll(() => state.active).toBe(0)
  })

  it('observes caller cancellation and does not execute a late response', async () => {
    const { run, state, started, effects } = await composition()
    state.hang = true
    const arrived = started()
    const controller = new AbortController()
    const pending = run('terminal', {}, undefined, controller.signal)
    await arrived
    controller.abort(new Error('fixture cancellation'))
    expect((await pending).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it.each([{ body: '{}' }, { body: 'not json' }, { reviewStatus: 503 }, { disconnect: true }])('fails closed on unavailable/invalid transport %#', async (value) => {
    const { run, state, effects } = await composition()
    Object.assign(state, value)
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
  })

  it('rejects oversized complete requests and responses without truncation', async () => {
    const small = await composition({ maxActionBytes: 1 })
    expect((await small.run()).isError).toBe(true)
    expect(small.actions).toEqual([])
    const response = await composition({ maxResponseBytes: 1 })
    expect((await response.run()).isError).toBe(true)
    expect(response.effects).toEqual([])
  })

  it('rejects relative sockets and validates explicit resource budgets', () => {
    expect(() => LinuxActionReview.Config({ socketPath: 'relative' })).toThrow('must be absolute')
    expect(() => LinuxActionReview.Config({ timeoutMs: 0 })).toThrow()
    expect(() => LinuxActionReview.Config({ maxResponseBytes: 0 })).toThrow()
    expect(LinuxActionReview.Config({})).toMatchObject({ socketPath: '/run/course-public/control.sock', timeoutMs: 30_000 })
  })

  it('does not allow unexpected reviewer exceptions to escape as permission', async () => {
    const { ctx, run, effects } = await composition()
    vi.spyOn(ctx.actionReview, 'review').mockRejectedValueOnce(new Error('fixture transport defect'))
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
    vi.restoreAllMocks()
    vi.spyOn(ctx.actionReview, 'review').mockRejectedValueOnce(new ActionReviewError('ACTION_REVIEW_AUDIT'))
    expect((await run()).isError).toBe(true)
    expect(effects).toEqual([])
  })
})
