import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Storage from '@deepseek-ai/dsh-storage'
import * as Sqlite from '@deepseek-ai/dsh-storage-sqlite'
import * as Domains from '@deepseek-ai/dsh-storage-domain'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Llm from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import Memory from '../src/index.ts'
import { digest } from '../src/identity.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'memory fixture teardown failed')
})
export const evidence = { source: 'fixture', locator: 'fixture:observation', contentHash: digest('fixture'),
  summary: 'Fixture observation', observedAt: '2026-01-01T00:00:00.000Z' }
export const context = { environment: 'production', principal: 'anonymous', vantage: 'external' }
export const config = { businessId: 'example', businessName: 'Example business', assessmentId: 'assessment-1',
  objectives: ['Assess public services'], scopePolicyHash: 'fixture-policy',
  validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z', domainName: 'example_memory' }
export const observation = { kind: 'domain', value: 'API.Example.test.', attributes: {}, confidence: 1, basis: 'observed' }
export const capture = { kind: 'capture', observations: [observation], evidence, coverage: 'best-effort' }
export const session = SessionId('operator-one')

export async function composition(options: { path?: string; extra?: Partial<import('../src/index.ts').Config> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assessment-memory-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const path = options.path ?? join(root, 'memory.sqlite')
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, { include: Include, storage: Storage, sqlite: Sqlite, domains: Domains, tools: Tools,
    prompt: SystemPrompt, memory: Memory,
    sessions: Sessions, projections: Projections, llm: Llm, agents: Agents })
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:storage' }, { name: 'cordis:sqlite', config: { path } }, { name: 'cordis:domains', config: { backend: 'sqlite' } },
    { name: 'cordis:prompt' }, { name: 'cordis:tools' }, { name: 'cordis:sessions' }, { name: 'cordis:projections' },
    { name: 'cordis:llm' }, { name: 'cordis:agents' },
    { id: 'memory', name: 'cordis:memory', config: { ...config, ...options.extra } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  const memory = ctx.assessmentMemory

  const query = async (view: string, extra = {}) => JSON.parse(await memory.query(session, { view,
    ...extra })) as {
    items: { id: string; revision: number; status: string; value: string; outcome: string; [key: string]: unknown }[]
    total: number
    nextOffset: number | null
  }
  const record = async (key: string, value: unknown) => JSON.parse(await memory.record(session, key,
    value)) as { eventId: string; assetIds: string[]; observationIds: string[] }
  return { ctx, root, path, memory, query, record }
}
