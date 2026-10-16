/** Real Loader, signed browser authentication and native management routes. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import * as Jsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as NativeViewer from '@deepseek-ai/dsh-experimental-trajectory-viewer/native-management'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Frontend from '@deepseek-ai/dsh-host-frontend-static'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Runtime from '../src/index.ts'
import type { CourseView } from '../src/types.ts'

const resources: { ctx: Context; root: string }[] = []
afterEach(async () => {
  for (const { ctx, root } of resources.splice(0).reverse()) {
    await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true })
  }
})
async function boot(role = 'instructor', options: { allowHostResearch?: boolean; toolsAfter?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-course-loader-'))
  const ctx = new Context(); resources.push({ ctx, root })
  await writeFile(join(root, 'index.html'), '<head></head><body>fixture</body>')
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, credentials: Credentials, web: WebServer, connection: Connection, frontend: Frontend,
    runtime: Runtime, persistence: Jsonl, nativeViewer: NativeViewer, tools: Tools, systemPrompt: SystemPrompt,
  })
  const path = join(root, 'cordis.yml')
  await writeFile(path, JSON.stringify([
    { name: 'cordis:credentials', config: { path: join(root, 'credentials.yaml'), watch: false } },
    { name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } }, { name: 'cordis:connection' },
    { name: 'cordis:frontend', config: { distIndex: join(root, 'index.html') } },
    { name: 'cordis:persistence', config: { root: join(root, 'sessions'), compression: 'none' } },
    ...(options.toolsAfter === undefined ? [] : [{ name: 'cordis:systemPrompt' }]),
    ...(options.toolsAfter === false ? [{ name: 'cordis:tools' }] : []),
    ...(role === 'research' ? [{ name: 'cordis:nativeViewer' }] : []),
    { id: 'course-runtime', name: 'cordis:runtime', config: { role, sourceRoot: resolve('.'), stateRoot: join(root, 'state'), dockerContext: 'fixture-never-use', python: 'python3', ...options.allowHostResearch === undefined ? {} : { allowHostResearch: options.allowHostResearch } } },
    ...(options.toolsAfter === true ? [{ name: 'cordis:tools' }] : []),
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
  await ctx.loader.await()
  const origin = ctx.webServer.getOrigin()
  const auth = await fetch(ctx.connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  const cookie = auth.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  await auth.text()
  expect(cookie).not.toBe('')
  return { ctx, origin, cookie, root }
}
it('authenticates management, validates drafts and rejects concurrent stale revisions through HTTP', async () => {
  const { origin, cookie } = await boot()
  expect((await fetch(`${origin}/course-runtime/status`)).status).toBe(401)
  expect((await fetch(`${origin}/course-runtime/status`, { headers: { cookie, origin: 'https://attacker.test' } })).status).toBe(403)
  const response = await fetch(`${origin}/course-runtime/status`, { headers: { cookie } })
  expect(response.status).toBe(200)
  const state = await response.json() as CourseView
  expect(state.runtime.phase).toBe('stopped')
  const save = () => fetch(`${origin}/course-runtime/draft`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(state.draft) })
  const saves = await Promise.all([save(), save()])
  expect(saves.map(row => row.status).sort()).toEqual([200, 409])
  const recovery = await fetch(`${origin}/runtimes/course/`, { headers: { cookie } })
  expect(recovery.status).toBe(503)
  expect(await recovery.text()).toContain('Return to Host management')
})

for (const toolsAfter of [false, true]) it(`denies native tools monotonically with Tools mounted ${toolsAfter ? 'after' : 'before'} the course owner`, async () => {
  const { ctx } = await boot('instructor', { toolsAfter })
  let bodies = 0, wrappers = 0
  ctx.tools.register(defineTool({ name: 'host_fixture', description: 'Observable native effect', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies++; return 'executed' } }))
  ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
  ctx.on('tools/execute', async (_call, next) => { wrappers++; return next() })
  const run = () => ctx.tools.execute({ name: 'host_fixture', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('host') })
  const denied = await run()
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain('host is management-only')
  expect([bodies, wrappers]).toEqual([0, 0])
  const table: IndexInjection[] = []; ctx.emit('webserver/index-inject', table)
  expect(table).toContainEqual({ kind: 'global', name: '__DSH_COURSE_RUNTIME_CONFIG__', value: { allowHostResearch: false } })
  const entry = [...ctx.loader.entries()].find(row => row.options.id === 'course-runtime')
  expect(entry?.fiber).toBeDefined(); await entry?.fiber?.dispose()
  expect((await run()).isError).toBe(true)
  expect([bodies, wrappers]).toEqual([0, 0])
})

it('keeps host admission closed after consumer removal before Tools mounts and across provider replacement', async () => {
  const { ctx } = await boot()
  const runtime = [...ctx.loader.entries()].find(row => row.options.id === 'course-runtime')
  expect(runtime?.fiber).toBeDefined(); await runtime?.fiber?.dispose()
  await ctx.plugin(SystemPrompt)
  const firstProvider = ctx.plugin(Tools); await firstProvider.await(); await ctx.fiber.await()
  let bodies = 0
  const register = () => { ctx.tools.register(defineTool({ name: 'host_late', description: 'Observable host effect', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies++; return 'executed' } })) }
  const call = { name: 'host_late', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('late-host') }
  register()
  const firstRegistry = ctx.tools
  expect((await firstRegistry.execute(call)).isError).toBe(true)
  await firstProvider.dispose()
  expect((await firstRegistry.execute(call)).isError).toBe(true)
  const secondProvider = ctx.plugin(Tools); await secondProvider.await(); await ctx.fiber.await()
  register()
  expect(ctx.tools).not.toBe(firstRegistry)
  const denied = await ctx.tools.execute(call)
  expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('host is management-only')
  expect(bodies).toBe(0)
})

it('cannot reopen an already-latched process by reloading the instructor escape', async () => {
  const { ctx, root } = await boot('instructor', { toolsAfter: false })
  const runtime = [...ctx.loader.entries()].find(row => row.options.id === 'course-runtime')
  expect(runtime?.fiber).toBeDefined(); await runtime?.fiber?.dispose()
  await ctx.loader.create({ name: 'cordis:runtime', config: { role: 'instructor', allowHostResearch: true,
    sourceRoot: resolve('.'), stateRoot: join(root, 'state'), dockerContext: 'fixture-never-use', python: 'python3' } })
  await ctx.loader.await()
  let bodies = 0
  ctx.tools.register(defineTool({ name: 'host_reloaded', description: 'Observable host effect', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies++; return 'executed' } }))
  const denied = await ctx.tools.execute({ name: 'host_reloaded', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('reload-host') })
  expect(denied.isError).toBe(true); expect(JSON.stringify(denied.content)).toContain('host is management-only')
  expect(bodies).toBe(0)
})

it('keeps the instructor escape explicit and never force-allows through another guard', async () => {
  const { ctx } = await boot('instructor', { toolsAfter: false, allowHostResearch: true })
  let bodies = 0
  ctx.tools.register(defineTool({ name: 'host_fixture', description: 'Observable native effect', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies++; return 'executed' } }))
  const run = () => ctx.tools.execute({ name: 'host_fixture', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('host') })
  expect((await run()).isError).toBe(false); expect(bodies).toBe(1)
  ctx.tools.guard(() => 'Independent instructor policy')
  expect((await run()).isError).toBe(true); expect(bodies).toBe(1)
  const table: IndexInjection[] = []; ctx.emit('webserver/index-inject', table)
  expect(table).toContainEqual({ kind: 'global', name: '__DSH_COURSE_RUNTIME_CONFIG__', value: { allowHostResearch: true } })
})

it('does not blanket-deny tools in the isolated research composition', async () => {
  const { ctx } = await boot('research', { toolsAfter: true, allowHostResearch: true })
  let bodies = 0
  ctx.tools.register(defineTool({ name: 'isolated_fixture', description: 'Research tool', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { bodies++; return 'executed' } }))
  expect((await ctx.tools.execute({ name: 'isolated_fixture', arguments: {}, signal: new AbortController().signal, callId: ToolCallId('isolated') })).isError).toBe(false)
  expect(bodies).toBe(1)
  const table: IndexInjection[] = []; ctx.emit('webserver/index-inject', table)
  expect(table).toContainEqual({ kind: 'global', name: '__DSH_COURSE_RUNTIME_CONFIG__', value: { allowHostResearch: false } })
})
it('research exposes authenticated activity but cannot write native policy or run management operations', async () => {
  const { origin, cookie, ctx } = await boot('research')
  const response = await fetch(`${origin}/course-runtime/action`, { method: 'POST', headers: { cookie }, body: '{}' })
  expect(response.status).toBe(403)
  expect(ctx.courseRuntime.controller).toBeUndefined()
  expect((await fetch(`${origin}/course-runtime/activity`, { headers: { cookie } })).status).toBe(200)
  await expect(ctx.serial('plugin-manager/before-change', { kind: 'plugin', target: 'course-network-scope-guard', enabled: false })).rejects.toThrow('Stop Protected')
})
it('native lifecycle guards reject bundle and component changes while research has not stopped', async () => {
  const { ctx, root } = await boot()
  await writeFile(join(root, 'state/status.json'), JSON.stringify({ phase: 'running', healthy: true, researchStopped: false }))
  for (const target of ['@deepseek-ai/dsh-experimental-network-scope-bundle', '@deepseek-ai/dsh-experimental-recon-bundle', 'course-runtime', 'course-recon-ui']) {
    await expect(ctx.serial('plugin-manager/before-change', { kind: 'bundle', target, enabled: false })).rejects.toThrow('Stop the protected runtime')
    await expect(ctx.serial('plugin-manager/before-change', { kind: 'remove', target })).rejects.toThrow('Stop the protected runtime')
  }
})

it('research composes the native viewer client without a collector or native management API', async () => {
  const { ctx, origin, cookie } = await boot('research')
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  expect(table).toContainEqual({ kind: 'global', name: '__DSH_TRAJECTORY_VIEWER_CONFIG__', value: {
    pollIntervalMs: 1500, apiBasePath: '/api/trajectory-viewer/',
  } })
  expect(ctx.get('trajectoryCollector')).toBeUndefined()
  expect((await fetch(`${origin}/api/trajectory-viewer/status`, { headers: { cookie } })).status).toBe(404)
  expect((await fetch(`${origin}/course-runtime/archive`)).status).toBe(401)
  expect((await fetch(`${origin}/course-runtime/archive`, { headers: { cookie, origin: 'https://attacker.test' } })).status).toBe(403)
  expect((await fetch(`${origin}/course-runtime/archive`, { method: 'POST', headers: { cookie } })).status).toBe(405)
})

it('research exposes exact persisted records with validated offsets and no mutation', async () => {
  const { ctx, origin, cookie } = await boot('research')
  const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId('protected-recorded'), createdAt: 1, isSeeded: false, delegationDepth: 0 }
  const event = { type: 'turn/start' as const, seq: SessionSeq(0), time: 2, data: { turn: 1 } }
  const writer = await ctx.sessionPersistence.create(header)
  await writer.append([event]); await writer.close()
  const get = (query = '') => fetch(`${origin}/course-runtime/archive${query}`, { headers: { cookie } })
  expect(await (await get()).json()).toEqual({ sessions: ['protected-recorded'] })
  const result: unknown = await (await get('?sessionId=protected-recorded')).json()
  expect(result).toEqual({ records: [
    { sessionId: header.id, sequence: -1, type: 'session/header', timestamp: 1, content: JSON.stringify({ header, inheritedEventCount: 0 }) },
    { sessionId: header.id, sequence: 0, type: event.type, timestamp: 2, content: JSON.stringify(event) },
  ], next: 1 })
  expect(await (await get('?sessionId=protected-recorded&after=1')).json()).toEqual({ records: [], next: 1 })
  for (const query of ['?unexpected=1', '?sessionId=x&after=-2', '?sessionId=x&after=01', '?sessionId=x&after=1&after=2']) {
    expect((await get(query)).status).toBe(400)
  }
  const reader = await ctx.sessionPersistence.open(header.id, 'read')
  expect((await reader.read(0, 100)).events).toEqual([event]); await reader.close()
})
