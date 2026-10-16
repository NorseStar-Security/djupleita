/** Native intake uses real durable receipts; lifecycle and backend transport are bounded fixtures. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Sqlite from '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { RuntimeController } from '../src/controller.ts'
import { mountProtectedArchive } from '../src/archive.ts'
import type { CourseRuntimeState, CourseView } from '../src/types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  vi.restoreAllMocks(); vi.useRealTimers()
  if (errors.length) throw new AggregateError(errors, 'Native course archive cleanup failed')
})

// Only presence is consumed here; projection query behavior belongs to its real
// provider suite. The identity fixture models the native config-editor result.
class ProjectionPresence extends Service {
  constructor(ctx: Context) { super(ctx, 'trajectoryProjection') }
}
class IdentityConfiguration extends Service {
  constructor(ctx: Context) { super(ctx, 'configEditor') }
  configuration() { return [{ entry: { options: { id: 'course-trajectory-archive' }, fiber: { config: {
    installationId: 'native-fixture', studentId: 'student-fixture', cohortId: 'cohort-fixture',
  } } } }] }
}

function view(phase: CourseRuntimeState['phase']): CourseView {
  const config = { policy: {}, provider: { socketPath: '/fixture', timeoutMs: 100, maxResponseBytes: 1000 },
    guard: { pollIntervalMs: 100, targetTools: [] }, recon: {}, actionReview: {}, forwardOpenAIKey: false }
  return { draft: { revision: 1, config }, defaults: config, reconEnabled: false, openAIKeyAvailable: false,
    versions: {}, activity: [], runtime: { phase, healthy: phase === 'running', prepared: true,
      appliedRevision: 1, policyHash: 'a'.repeat(64), reviewHash: 'b'.repeat(64) } }
}
class ControllerFixture extends RuntimeController {
  phase: CourseRuntimeState['phase'] = 'running'
  source = vi.fn(async (query: URLSearchParams): Promise<unknown> => query.has('sessionId')
    ? { records: Number(query.get('after')) > 0 ? [] : records } : { sessions: ['course-session'] })
  lease = vi.fn(async (_deployment: Parameters<RuntimeController['renewArchiveLease']>[0]): Promise<void> => {})
  stopped = vi.fn(async (): Promise<void> => { this.phase = 'failed' })
  constructor() { super({ sourceRoot: '/fixture-never-access', stateRoot: '/fixture-never-access',
    python: 'fixture-never-spawn', dockerContext: 'fixture-never-connect', operationTimeoutMs: 1000 }, 'http://fixture.invalid/') }
  override async view() { return view(this.phase) }
  override async archive(query: URLSearchParams) { return this.source(query) }
  override async renewArchiveLease(deployment: Parameters<RuntimeController['renewArchiveLease']>[0]) { await this.lease(deployment) }
  override async stopForArchiveFailure() { this.trajectoryError = true; await this.stopped() }
}
const header = { version: SESSION_FORMAT_VERSION, id: SessionId('course-session'), createdAt: 1, isSeeded: false, delegationDepth: 0 }
const event = { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } }
const records = [
  { sessionId: header.id, sequence: -1, type: 'session/header', timestamp: 1, content: JSON.stringify({ header, inheritedEventCount: 0 }) },
  { sessionId: header.id, sequence: 0, type: event.type, timestamp: 2, content: JSON.stringify(event) },
]
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-course-native-archive-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  const collector = ctx.plugin(Sqlite, Sqlite.Config({ path: join(root, 'intake', 'collector.sqlite') })); await collector.await()
  const projection = ctx.plugin(ProjectionPresence); await projection.await()
  await ctx.plugin(IdentityConfiguration)
  const controller = new ControllerFixture()
  const start = () => ctx.plugin({ name: 'native-archive-fixture', apply(owner: Context) { mountProtectedArchive(owner, controller, 1000) } })
  return { ctx, controller, projection, collector, start }
}

it('renews admission only after complete durable intake and replays exact records without duplicate receipts', async () => {
  const { ctx, controller, start } = await fixture()
  vi.useFakeTimers()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
  vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => {
    if (args[1].sequence === 0) { entered.resolve(undefined); await release.promise }
    return append(...args)
  })
  const fiber = start()
  try {
    await fiber.await(); await entered.promise
    expect((await ctx.trajectoryCollector.status()).records).toBe(1)
    expect(controller.lease).not.toHaveBeenCalled(); expect(controller.trajectoryError).toBeUndefined()
    release.resolve(undefined)
    await vi.waitFor(() => { expect(controller.trajectoryError).toBe(false) })
    expect(controller.lease).toHaveBeenCalledTimes(1)
    expect(controller.lease).toHaveBeenCalledWith({ revision: 1, policyHash: 'a'.repeat(64), reviewHash: 'b'.repeat(64) })
    const page = await ctx.trajectoryCollector.read({ after: 0, limit: 100, maxBytes: 10000 })
    expect(page.records.map(row => row.content)).toEqual(records.map(row => row.content))
    expect(page.records[0]?.identity).toMatchObject({ studentId: 'student-fixture', cohortId: 'cohort-fixture' })
    expect(page.records[0]?.identity.installationId).toMatch(/^protected-[a-f0-9]{64}$/)
    await vi.advanceTimersByTimeAsync(1000)
    expect((await ctx.trajectoryCollector.status()).records).toBe(2)
    expect(controller.lease).toHaveBeenCalledTimes(2)
    expect(controller.source.mock.calls.at(-1)?.[0].get('after')).toBe('1')
  } finally { release.resolve(undefined); await fiber.dispose() }
  expect(controller.stopped).toHaveBeenCalledOnce()
})

for (const failure of ['source', 'shape', 'receipt', 'lease'] as const) it(`stops research visibly on ${failure} failure and does not acknowledge readiness`, async () => {
  const { ctx, controller, start } = await fixture()
  if (failure === 'source') controller.source.mockRejectedValue(new Error('Transport fixture failure'))
  if (failure === 'shape') controller.source.mockResolvedValue({ sessions: [false] })
  if (failure === 'receipt') vi.spyOn(ctx.trajectoryCollector, 'append').mockRejectedValue(new Error('Durable receipt fixture failure'))
  if (failure === 'lease') controller.lease.mockRejectedValue(new Error('Lease fixture failure'))
  const fiber = start(); await fiber.await()
  await vi.waitFor(() => { expect(controller.stopped).toHaveBeenCalledOnce() })
  expect(controller.trajectoryError).toBe(true); expect(controller.phase).toBe('failed')
  expect(controller.lease).toHaveBeenCalledTimes(failure === 'lease' ? 1 : 0)
  await fiber.dispose(); expect(controller.stopped).toHaveBeenCalledOnce()
})

it('drains an in-flight receipt on unload, never renews afterward, and confirms research stopped', async () => {
  const { ctx, controller, start } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
  vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => {
    entered.resolve(undefined); await release.promise; return append(...args)
  })
  const fiber = start(); await fiber.await(); await entered.promise
  let disposed = false
  const closing = fiber.dispose().then(() => { disposed = true })
  try {
    await Promise.resolve(); expect(disposed).toBe(false); expect(controller.stopped).not.toHaveBeenCalled()
    release.resolve(undefined); await closing
    expect((await ctx.trajectoryCollector.status()).records).toBe(1)
    expect(controller.lease).not.toHaveBeenCalled(); expect(controller.stopped).toHaveBeenCalledOnce()
    expect(controller.trajectoryError).toBe(true)
  } finally { release.resolve(undefined); await closing }
})

it('stops when a mandatory injected service is removed, but never stops an idle runtime', async () => {
  const active = await fixture(), fiber = active.start(); await fiber.await()
  await vi.waitFor(() => { expect(active.controller.trajectoryError).toBe(false) })
  await active.projection.dispose()
  expect(active.controller.stopped).toHaveBeenCalledOnce(); expect(active.controller.trajectoryError).toBe(true)
  await fiber.dispose()
  const idle = await fixture(); idle.controller.phase = 'stopped'
  const idleFiber = idle.start(); await idleFiber.await(); await idleFiber.dispose()
  expect(idle.controller.source).not.toHaveBeenCalled(); expect(idle.controller.lease).not.toHaveBeenCalled()
  expect(idle.controller.stopped).not.toHaveBeenCalled(); expect(idle.controller.trajectoryError).toBeUndefined()
})

it('reports a failed stop without pretending the runtime or collector is healthy', async () => {
  const { ctx, controller, start } = await fixture()
  controller.source.mockRejectedValue(new Error('Transport fixture failure'))
  controller.stopped.mockRejectedValue(new Error('Stop fixture failure'))
  const fiber = start(); await fiber.await()
  await vi.waitFor(() => { expect(ctx.logger.buffer.some(row => row.type === 'error')).toBe(true) })
  expect(controller.trajectoryError).toBe(true); expect(controller.lease).not.toHaveBeenCalled()
  await fiber.dispose()
  expect(ctx.logger.buffer.filter(row => row.type === 'error')).toHaveLength(2)
})

it('fails closed if collector removal rejects a pending, unacknowledged receipt', async () => {
  const { ctx, controller, collector, start } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
  let committed = false, settled = false
  vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => {
    entered.resolve(undefined); await release.promise
    try { const receipt = await append(...args); committed = true; return receipt } finally { settled = true }
  })
  const fiber = start(); await fiber.await(); await entered.promise
  let disposed = false
  const closing = collector.dispose().then(() => { disposed = true })
  try {
    await Promise.resolve(); expect(disposed).toBe(false)
    release.resolve(undefined); await closing
    expect(settled).toBe(true); expect(committed).toBe(false); expect(controller.stopped).toHaveBeenCalledOnce()
    expect(controller.lease).not.toHaveBeenCalled(); expect(controller.trajectoryError).toBe(true)
  } finally { release.resolve(undefined); await closing; await fiber.dispose() }
})

for (const stage of ['page', 'renewal'] as const) it(`does not publish readiness when unloaded during the final ${stage}`, async () => {
  const { controller, start } = await fixture()
  const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  if (stage === 'page') controller.source.mockImplementation(async () => {
    entered.resolve(undefined); await release.promise; return { sessions: [] }
  })
  else controller.lease.mockImplementation(async () => { entered.resolve(undefined); await release.promise })
  const fiber = start(); await fiber.await(); await entered.promise
  const closing = fiber.dispose()
  try {
    release.resolve(undefined); await closing
    expect(controller.trajectoryError).toBe(true); expect(controller.stopped).toHaveBeenCalledOnce()
    expect(controller.lease).toHaveBeenCalledTimes(stage === 'page' ? 0 : 1)
  } finally { release.resolve(undefined); await closing }
})
