import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as ScopeJudge from '@deepseek-ai/dsh-scope-judge'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

it('loads the real plugin namespace from cordis.yml and denies before an observable side effect', async () => {
  ctx = new Context()
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, 'system-prompt': SystemPrompt, tools: ToolRuntime, 'scope-judge': ScopeJudge })
  await ctx.loader.create({ name: 'cordis:include', config: { path: new URL('./fixtures/cordis.yml', import.meta.url).href } })
  await ctx.loader.await()
  expect('default' in ScopeJudge).toBe(false)
  expect(ctx.loader.unwrapExports(ScopeJudge)).toBe(ScopeJudge)
  const effects: string[] = []
  ctx.tools.register(defineTool({
    name: 'web_fetch', description: 'Fetch fixture',
    parameters: { url: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { effects.push(args.url); return 'body executed' },
  }))
  const run = (url: string) => ctx!.tools.execute({ signal: new AbortController().signal, callId: ToolCallId('loader'), name: 'web_fetch', arguments: { url } })
  expect((await run('https://example.test')).isError).toBe(false)
  const denied = await run('https://evil.test')
  expect(denied.isError).toBe(true)
  expect(denied.content).toEqual([{ type: 'text', text: 'Error: scope judge denied "web_fetch": target domain "evil.test" is outside scope. Allowed domains: example.test' }])
  expect(effects).toEqual(['https://example.test'])
})
