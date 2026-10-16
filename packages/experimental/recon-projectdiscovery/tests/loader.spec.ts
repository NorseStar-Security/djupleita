import { mkdtemp, readFile, rm, writeFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { NetworkScopePolicy } from '@deepseek-ai/dsh-experimental-network-scope'
import type { ScopeInspection, ScopeTarget } from '@deepseek-ai/dsh-experimental-network-scope/types'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import Projections from '@deepseek-ai/dsh-session-projection'
import Sessions from '@deepseek-ai/dsh-session'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SandboxProvider, type ConfinedArgv } from '@deepseek-ai/dsh-sandbox'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import ProjectDiscoveryRecon, { type Config } from '../src/index.ts'
import * as ReconTools from '@deepseek-ai/dsh-experimental-recon-tools'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'recon fixture teardown failed')
})

class GatewayFixture extends NetworkScopePolicy {
  healthy = true
  policyHash = 'fixture-policy'
  denyUrls = false
  policy: ScopeInspection['policy'] = { domains: ['example.test', '*.example.test'], ips: ['198.51.100.0/24'], exclude_ips: ['198.51.100.9'], infrastructure: { 'api.vendor.test': { methods: ['GET'], paths: ['/'] } } }
  override async inspect(_after: number | undefined, targets: readonly ScopeTarget[], signal: AbortSignal): Promise<ScopeInspection> {
    signal.throwIfAborted()
    return { protocol: 1, instance: 'fixture', policyHash: this.policyHash, healthy: this.healthy, boundary: 'linux-netns-nftables', uid: 1000,
      policy: this.policy,
      allowed: !this.denyUrls && targets.every(target => new URL(target.url).hostname === 'example.test'), firstSeq: 0, nextSeq: 0, events: [] }
  }
}

async function composition(config: Partial<Config> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'recon-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const executable = join(root, 'recon-cli')
  await writeFile(executable, await readFile(new URL('./fixtures/cli.mjs', import.meta.url)))
  await chmod(executable, 0o700)
  const control = (value: object) => writeFile(join(root, 'control.json'), JSON.stringify(value))
  await control({})
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, gateway: GatewayFixture, subprocess: LocalSubprocess, recon: ProjectDiscoveryRecon,
    'recon-tools': ReconTools, tools: Tools, prompt: SystemPrompt, sandbox: SandboxPolicy, projections: Projections, sessions: Sessions })
  const executables = Object.fromEntries(['subfinder', 'urlfinder', 'dnsx', 'httpx', 'naabu', 'katana'].map(name => [name, executable]))
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:gateway' }, { name: 'cordis:subprocess' }, { name: 'cordis:prompt' }, { name: 'cordis:tools' },
    { name: 'cordis:sessions' }, { name: 'cordis:projections' }, { name: 'cordis:sandbox', config: { mode: 'danger-full-access', workspaceRoot: root } },
    { id: 'recon', name: 'cordis:recon', config: { executables, ...config } }, { id: 'consumer', name: 'cordis:recon-tools' },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  const gateway = ctx.networkScope as GatewayFixture
  const signal = new AbortController().signal
  const run = (targets = ['example.test'], extra = {}) => ctx.recon.run({ component: 'subfinder', targets, allowActive: false, sandbox: { mode: 'danger-full-access', workspaceRoot: root }, ...extra }, signal)
  const effects = async (): Promise<{ argv: string[]; input: string; home: string; key?: string; pid: number }[]> => {
    try { return (await readFile(join(root, 'effects.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { argv: string[]; input: string; home: string; key?: string; pid: number }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  return { root, ctx, gateway, run, control, effects }
}

describe.skipIf(process.platform === 'win32')('recon through the Loader and managed local subprocesses', () => {
  it('validates proxy configuration and rejects a remote execution provider', async () => {
    expect(() => ProjectDiscoveryRecon.Config({ ...ProjectDiscoveryRecon.Config(), proxy: 'https://proxy.test/path' })).toThrow('recon proxy')
    class Remote extends SubprocessRuntime {
      override resolveExecutable(): Promise<never> { return Promise.reject(new Error('unused')) }
      override terminalEnvironment(): Promise<never> { return Promise.reject(new Error('unused')) }
      override spawn(): never { throw new Error('unused') }
      override spawnTerminal(): Promise<never> { return Promise.reject(new Error('unused')) }
    }
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    await ctx.plugin(Remote)
    expect(() => new ProjectDiscoveryRecon(ctx, ProjectDiscoveryRecon.Config())).toThrow('requires local subprocess')
  })
  it('rejects empty and oversized target batches and oversized complete results', async () => {
    const { run, effects } = await composition({ maxTargets: 1, maxBytes: 200 })
    await expect(run([])).rejects.toHaveProperty('code', 'RECON_TARGET')
    await expect(run(['example.test', 'app.example.test'])).rejects.toHaveProperty('code', 'RECON_TARGET')
    expect(await effects()).toHaveLength(0)
    await expect(run()).rejects.toHaveProperty('code', 'RECON_OUTPUT')
  })
  it('respects fully enforced file policies and rejects partial enforcement', async () => {
    const { ctx, run, root, effects } = await composition()
    class FileSandbox extends SandboxProvider {
      enforcement: 'full' | 'partial' = 'partial'
      override confine(argv: readonly string[]): Promise<ConfinedArgv> {
        return Promise.resolve({ argv: [...argv], enforcement: this.enforcement, denialSignatures: [], runnerFailureRules: [] })
      }
    }
    await ctx.plugin(FileSandbox)
    const sandbox = { mode: 'read-only', workspaceRoot: root }
    await expect(run(['example.test'], { sandbox })).rejects.toHaveProperty('code', 'RECON_UNAVAILABLE')
    expect(await effects()).toHaveLength(0)
    ;(ctx.sandbox as FileSandbox).enforcement = 'full'
    await expect(run(['example.test'], { sandbox })).resolves.toHaveProperty('coverage', 'best-effort')
  })
  it('routes model tool runs through resolved session and agentless policies', async () => {
    const { ctx, root } = await composition()
    const call = (extra = {}) => ctx.tools.execute({ name: 'recon_run', arguments: { component: 'subfinder', targets: ['example.test'], allowActive: false }, signal: new AbortController().signal, callId: ToolCallId('run'), ...extra })
    expect((await call()).isError).toBe(false)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(AgentRegistry)
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(SessionId('recon-agent'), {}, { cwd: root })
    expect((await call({ agent })).isError).toBe(false)
  })
  it('bounds the whole execution deadline and leaves no child alive', async () => {
    const { run, control, effects } = await composition({ timeoutMs: 200 })
    await control({ hang: true })
    await expect(run()).rejects.toThrow()
    for (const call of await effects()) expect(() => process.kill(call.pid, 0)).toThrow()
  })
  it('rejects out-of-scope names, IPs, infrastructure, and missing active consent before spawning', async () => {
    const { run, effects } = await composition()
    for (const target of ['widgets.test', 'example.test.widgets.test', 'api.vendor.test']) await expect(run([target])).rejects.toHaveProperty('code', 'RECON_SCOPE')
    await expect(run(['198.51.100.9'], { component: 'naabu', allowActive: true })).rejects.toHaveProperty('code', 'RECON_SCOPE')
    await expect(run(['198.51.101.1'], { component: 'naabu', allowActive: true })).rejects.toHaveProperty('code', 'RECON_SCOPE')
    await expect(run(['example.test'], { component: 'naabu', allowActive: true })).rejects.toHaveProperty('code', 'RECON_TARGET')
    await expect(run(['example.test'], { component: 'dnsx' })).rejects.toHaveProperty('code', 'RECON_ACTIVE')
    expect(await effects()).toEqual([])
  })
  it('accepts domain-only and IP-only gateway policies without granting the other target category', async () => {
    const { run, gateway, control, effects } = await composition()
    gateway.policy = { domains: ['example.test'] }
    await expect(run()).resolves.toHaveProperty('targets', ['example.test'])
    await expect(run(['198.51.100.1'], { component: 'naabu', allowActive: true })).rejects.toHaveProperty('code', 'RECON_SCOPE')
    gateway.policy = { ips: ['198.51.100.0/24'] }
    await control({ stdout: '{"ip":"198.51.100.1","port":443}\n' })
    await expect(run(['198.51.100.1'], { component: 'naabu', allowActive: true })).resolves.toHaveProperty('targets', ['198.51.100.1'])
    await expect(run()).rejects.toHaveProperty('code', 'RECON_SCOPE')
    expect(await effects()).toHaveLength(2)
  })
  it('executes all six components with private config, scrubbed credentials, normalized results, and cleanup', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-reach-recon')
    const { run, control, effects } = await composition()
    const cases = [
      { component: 'subfinder', targets: ['example.test'], stdout: '{"host":"widgets.test"}\n' },
      { component: 'urlfinder', targets: ['example.test'], stdout: '{"url":"https://widgets.test/a"}\n' },
      { component: 'dnsx', targets: ['example.test'], stdout: '{"host":"example.test","a":["198.51.101.1"]}\n' },
      { component: 'httpx', targets: ['https://example.test/'], stdout: '{"url":"https://example.test/","status_code":200}\n' },
      { component: 'naabu', targets: ['198.51.100.1'], stdout: '{"ip":"198.51.100.1","port":443}\n' },
      { component: 'katana', targets: ['https://example.test/'], stdout: '{"request":{"endpoint":"https://example.test/a"}}\n' },
    ] as const
    for (const value of cases) {
      await control({ stdout: value.stdout, stderr: 'upstream diagnostic' })
      const result = await run([...value.targets], { component: value.component, allowActive: true })
      expect(result.component).toBe(value.component)
      expect(result.coverage).toBe('best-effort')
      expect(result.diagnosticsPresent).toBe(true)
      expect(result.observations.length).toBeGreaterThan(0)
    }
    const calls = await effects()
    expect(calls).toHaveLength(6)
    expect(calls.every(value => value.key === undefined)).toBe(true)
    for (const value of calls) await expect(stat(value.home)).rejects.toHaveProperty('code', 'ENOENT')
    await expect(run(['widgets.test'])).rejects.toHaveProperty('code', 'RECON_SCOPE')
    expect(await effects()).toHaveLength(6)
  })
  it('rejects unhealthy and denied URL preflights and file policies without a sandbox', async () => {
    const { run, gateway, effects } = await composition()
    gateway.healthy = false
    await expect(run()).rejects.toHaveProperty('code', 'RECON_SCOPE')
    gateway.healthy = true
    gateway.denyUrls = true
    await expect(run(['https://example.test/'], { component: 'httpx', allowActive: true })).rejects.toHaveProperty('code', 'RECON_SCOPE')
    await expect(run(['example.test'], { sandbox: { mode: 'read-only', workspaceRoot: '/tmp' } })).rejects.toHaveProperty('code', 'RECON_UNAVAILABLE')
    expect(await effects()).toEqual([])
  })
  it.each([{ stdout: '{' }, { stdout: 'x'.repeat(3000) }, { stderr: 'x'.repeat(3000) }, { exit: 2 }])('fails visibly without accepting partial stdout: %j', async (value) => {
    const { run, control } = await composition({ maxBytes: 2048 })
    await control(value)
    await expect(run()).rejects.toThrow(/RECON_OUTPUT|RECON_PROCESS/)
  })
  it('rejects a changed gateway after execution', async () => {
    const { run, gateway } = await composition()
    const inspect = gateway.inspect.bind(gateway)
    let calls = 0
    vi.spyOn(gateway, 'inspect').mockImplementation(async (...args) => { const result = await inspect(...args); return { ...result, policyHash: ++calls === 1 ? 'first' : 'changed' } })
    await expect(run()).rejects.toHaveProperty('code', 'RECON_SCOPE')
  })
  it('joins a cancelled process before rejecting and removes private files', async () => {
    const { ctx, root, control, effects } = await composition()
    await control({ hang: true })
    const controller = new AbortController()
    const task = ctx.recon.run({ component: 'subfinder', targets: ['example.test'], allowActive: false, sandbox: { mode: 'danger-full-access', workspaceRoot: root } }, controller.signal)
    const settled = task.then(() => 'resolved', () => 'rejected')
    await expect.poll(async () => (await effects()).length).toBe(1)
    await expect(ctx.recon.run({ component: 'subfinder', targets: ['example.test'], allowActive: false, sandbox: { mode: 'danger-full-access', workspaceRoot: root } }, controller.signal)).rejects.toHaveProperty('code', 'RECON_UNAVAILABLE')
    controller.abort()
    expect(await settled).toBe('rejected')
    const [call] = await effects()
    expect(() => process.kill(call!.pid, 0)).toThrow()
    await expect(stat(call!.home)).rejects.toHaveProperty('code', 'ENOENT')
  })
  it('drains on provider disposal and unregisters both model tools on consumer unload', async () => {
    const { ctx, run, control, effects } = await composition()
    const catalog = await ctx.tools.execute({ name: 'recon_catalog', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('catalog') })
    expect(catalog.isError).toBe(false)
    expect(catalog.content[0]).toHaveProperty('text', expect.stringContaining('subfinder'))
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'consumer')
    await entry!.fiber!.dispose()
    expect(ctx.tools.get('recon_catalog')).toBeUndefined()
    expect(ctx.tools.get('recon_run')).toBeUndefined()
    await control({ hang: true })
    const task = run().then(() => 'resolved', () => 'rejected')
    await expect.poll(async () => (await effects()).length).toBe(1)
    const provider = [...ctx.loader.entries()].find(value => value.options.id === 'recon')
    await provider!.fiber!.dispose()
    expect(await task).toBe('rejected')
    const [call] = await effects()
    expect(() => process.kill(call!.pid, 0)).toThrow()
  })
})
