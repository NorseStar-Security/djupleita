import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as ScopeJudge from '@deepseek-ai/dsh-scope-judge'
import { createJudge } from '../src/judge.ts'

const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function setup(config: ScopeJudge.Config = { domains: ['example.test', '*.lab.test'] }) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const body = vi.fn(async () => [{ type: 'text' as const, text: 'executed' }])
  for (const name of ['web_fetch', 'bash', 'batch', 'read_file', 'terminal_input', 'mcp_probe']) {
    ctx.tools.register(defineContentToolFixture({ name, description: 'test tool', parameters: {}, execute: body }))
  }
  const fiber = await ctx.plugin(ScopeJudge, config)
  const run = (name: string, args: unknown) => ctx.tools.execute({
    signal: new AbortController().signal, callId: ToolCallId('scope-test'), name, arguments: args,
  })
  return { ctx, body, fiber, run }
}

describe('scope judge in the real executor', () => {
  it('supports omitted optional fields for programmatic composition', () => {
    const guard = createJudge({ domains: ['example.test'] })
    expect(guard({ name: 'web_fetch', arguments: { url: 'https://example.test' }, callId: ToolCallId('defaults'), signal: new AbortController().signal } as Parameters<typeof guard>[0])).toBeUndefined()
  })

  it('runs in-scope calls and blocks out-of-scope calls before the body or around-dispatch listeners', async () => {
    const { ctx, run, body } = await setup()
    const dispatch = vi.fn()
    ctx.on('tools/execute', (_exec, next) => { dispatch(); return next() })
    expect((await run('web_fetch', { url: 'https://EXAMPLE.test./a' })).isError).toBe(false)
    expect((await run('web_fetch', { url: 'https://a.lab.test' })).isError).toBe(false)
    const denied = await run('web_fetch', { url: 'https://evil.test' })
    expect(denied.isError).toBe(true)
    expect(denied.content).toEqual([{ type: 'text', text: 'Error: scope judge denied "web_fetch": target domain "evil.test" is outside scope. Allowed domains: example.test, *.lab.test' }])
    expect(body).toHaveBeenCalledTimes(2)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('cannot be overridden by a force-allow pre-execute listener', async () => {
    const { ctx, run, body } = await setup()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' }), { prepend: true })
    expect((await run('web_fetch', { url: 'https://evil.test' })).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it.each([{}, { url: '' }, { url: null }, { url: [] }, 'not json', null, { url: 'https://127.1' }])('fails closed for missing or malformed target %j', async (args) => {
    const { run, body } = await setup()
    expect((await run('web_fetch', args)).isError).toBe(true)
    expect(body).not.toHaveBeenCalled()
  })

  it('denies new tools and unrestricted execution even when their text contains an allowed domain', async () => {
    const { run, body } = await setup()
    for (const name of ['bash', 'run_code', 'terminal_input', 'mcp_probe', 'read_file']) {
      expect((await run(name, { command: 'example.test', url: 'https://example.test' })).isError).toBe(true)
    }
    expect(body).not.toHaveBeenCalled()
  })

  it('requires every target in every selected nested-array element to be authorized', async () => {
    const { run, body } = await setup({ domains: ['example.test'], targetTools: [{ name: 'batch', paths: ['/requests/*/url', '/callback/host'] }] })
    const allowed = { requests: [{ url: 'https://example.test/a' }, { url: 'example.test:443' }], callback: { host: 'example.test' } }
    expect((await run('batch', allowed)).isError).toBe(false)
    for (const args of [
      { ...allowed, requests: [...allowed.requests, { url: 'https://evil.test' }] },
      { ...allowed, requests: [{ url: 'https://example.test' }, {}] },
      { ...allowed, requests: [] }, { ...allowed, requests: {} },
      { ...allowed, callback: { host: 'evil.test' } },
    ]) expect((await run('batch', args)).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('supports JSON-pointer escaped property names', async () => {
    const { run } = await setup({ domains: ['example.test'], targetTools: [{ name: 'batch', paths: ['/a~1b/~0host'] }] })
    expect((await run('batch', { 'a/b': { '~host': 'example.test' } })).isError).toBe(false)
  })

  it('only exempts explicitly classified local tools', async () => {
    const { run, body } = await setup({ domains: ['example.test'], localTools: ['read_file'] })
    expect((await run('read_file', { path: 'notes.md' })).isError).toBe(false)
    expect((await run('terminal_input', {})).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('checks all literal Bash destinations and rejects alternate execution fields', async () => {
    const { run, body } = await setup({ domains: ['example.test'], shellTools: ['bash'] })
    expect((await run('bash', { command: 'nmap -sV -p 443 example.test', description: 'Probe lab' })).isError).toBe(false)
    for (const args of [
      { command: 'nmap example.test evil.test' },
      { command: 'curl -q https://example.test https://evil.test' },
      { command: 'dig -r evil.test A' },
      { command: 'curl -q https://example.test', env: { HTTPS_PROXY: 'evil.test' } },
      { command: 'curl -q https://example.test; python payload.py' },
      { command: 42 }, {},
    ]) expect((await run('bash', args)).isError).toBe(true)
    expect(body).toHaveBeenCalledTimes(1)
  })

  it('keeps separate judge instances conjunctive and unregisters only the disposed instance', async () => {
    const { ctx, run, body, fiber } = await setup({ domains: ['example.test'] })
    const other = await ctx.plugin({ ...ScopeJudge, name: 'second-scope-judge' }, { domains: ['other.test'] })
    expect((await run('web_fetch', { url: 'https://example.test' })).isError).toBe(true)
    await other.dispose()
    expect((await run('web_fetch', { url: 'https://example.test' })).isError).toBe(false)
    await fiber.dispose()
    expect((await run('web_fetch', { url: 'https://evil.test' })).isError).toBe(false)
    expect(body).toHaveBeenCalledTimes(2)
  })

  it('copies configuration so caller mutation cannot widen the active scope', async () => {
    const config = { domains: ['example.test'], targetTools: [{ name: 'web_fetch', paths: ['/url'] }], localTools: [] as string[] }
    const guard = createJudge(config)
    config.domains.push('evil.test')
    config.targetTools[0]!.paths[0] = '/decoy'
    config.localTools.push('web_fetch')
    expect(guard({ name: 'web_fetch', arguments: { url: 'https://evil.test', decoy: 'example.test' }, callId: ToolCallId('copy'), signal: new AbortController().signal } as Parameters<typeof guard>[0])).toContain('outside scope')
  })

  it.each([
    { domains: [] },
    { domains: ['https://example.test'] },
    { domains: ['example.test'], targetTools: [{ name: 'probe', paths: [] }] },
    { domains: ['example.test'], targetTools: [{ name: 'probe', paths: ['url'] }] },
    { domains: ['example.test'], targetTools: [{ name: 'probe', paths: ['/bad~2key'] }] },
    { domains: ['example.test'], localTools: ['web_fetch'] },
    { domains: ['example.test'], shellTools: ['bash'], localTools: ['bash'] },
    { domains: ['example.test'], localTools: ['a', 'a'] },
    { domains: ['example.test'], localTools: [''] },
    { domains: ['example.test'], localTools: [' spaced '] },
    { domains: ['example.test'], targetTools: [{ name: 'probe', paths: ['/url'] }, { name: 'probe', paths: ['/url'] }] },
  ])('rejects invalid or conflicting configuration before registration: %j', (config) => {
    expect(() => createJudge(config)).toThrow(/scope-judge:/)
  })
})
