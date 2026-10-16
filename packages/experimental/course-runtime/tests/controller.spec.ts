/** Revision fencing and authoritative policy validation use the actual native controller. */
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/controller.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(trajectories = true) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-course-control-')); roots.push(root)
  const controller = new RuntimeController({ sourceRoot: resolve('.'), stateRoot: root, dockerContext: 'fixture-do-not-connect', python: 'python3', operationTimeoutMs: 10000 }, 'http://127.0.0.1:3080/', async () => ({
    bundles: [], patches: [], credentials: { version: 1, refs: {}, records: {} }, trajectories,
    reviewCredentials: { OPENAI_API_KEY: 'fixture-private-review' },
  }))
  await controller.initialize()
  return { root, controller }
}
it('rejects stale concurrent edits and keeps pending settings independent of applied state', async () => {
  const { controller } = await fixture()
  const initial = await controller.draft()
  const edited = structuredClone(initial.config)
  edited.policy = { domains: ['research.test'] }
  const results = await Promise.allSettled([controller.save(0, edited), controller.save(0, initial.config)])
  expect(results.map(row => row.status)).toEqual(['fulfilled', 'rejected'])
  expect((await controller.view()).runtime.appliedRevision).toBeUndefined()
  expect((await controller.draft()).revision).toBe(1)
  await expect(controller.start({ action: 'apply', revision: 0, stopConfirmed: true })).rejects.toThrow('Settings changed')
})
it('uses Python CIDR semantics and leaves the durable draft unchanged on invalid settings', async () => {
  const { controller } = await fixture()
  const before = await controller.draft()
  const invalid = structuredClone(before.config)
  invalid.policy = { ips: ['192.0.2.19/24'] }
  await expect(controller.save(0, invalid)).rejects.toThrow()
  expect(await controller.draft()).toEqual(before)
  invalid.guard.targetTools = [invalid.guard.targetTools[0]!, invalid.guard.targetTools[0]!]
  expect(() => controller.configuration(invalid)).toThrow('Duplicate')
})
it('recovers interrupted operations without restoring or resuming a previous policy', async () => {
  const { root, controller } = await fixture()
  await writeFile(join(root, 'status.json'), JSON.stringify({ phase: 'starting', appliedRevision: 4 }))
  const next = new RuntimeController({ sourceRoot: resolve('.'), stateRoot: root, dockerContext: 'fixture-do-not-connect', python: 'python3', operationTimeoutMs: 10000 }, 'http://127.0.0.1:3080/')
  await next.initialize()
  expect((await next.view()).runtime).toMatchObject({ phase: 'failed', healthy: false })
  expect((JSON.parse(await readFile(join(root, 'status.json'), 'utf8')) as { error: string }).error).toContain('Interrupted')
  expect((await controller.draft()).revision).toBe(0)
})
it('failed startup retains the saved revision and stops research without selecting an older policy', async () => {
  const { controller } = await fixture()
  const configured = (await controller.draft()).config
  const evaluators = configured.actionReview?.evaluators
  if (!Array.isArray(evaluators) || typeof evaluators[0] !== 'object' || evaluators[0] === null || Array.isArray(evaluators[0])) throw new Error('Missing fixture reviewer')
  evaluators[0].model = 'fixture-review-model'
  const saved = await controller.save(0, configured)
  await controller.start({ action: 'apply', revision: saved.revision, stopConfirmed: false })
  await vi.waitFor(async () => {
    expect((await controller.view()).runtime).toMatchObject({ phase: 'failed', healthy: false, researchStopped: true })
  }, { timeout: 5000 })
  expect(await controller.draft()).toEqual(saved)
  expect((await controller.view()).applied).toBeUndefined()
  await controller.assertStopped()
})
it('saves an incomplete reviewer draft but refuses apply without stopping or changing the saved revision', async () => {
  const { controller } = await fixture()
  const saved = await controller.save(0, (await controller.draft()).config)
  await expect(controller.start({ action: 'apply', revision: saved.revision, stopConfirmed: true })).rejects.toThrow('explicit model')
  expect((await controller.view()).runtime.phase).toBe('stopped')
  expect(await controller.draft()).toEqual(saved)
})
it('requires the local collector even with a configured reviewer', async () => {
  const { controller } = await fixture(false)
  const config = (await controller.draft()).config
  const evaluators = config.actionReview?.evaluators
  if (!Array.isArray(evaluators) || typeof evaluators[0] !== 'object' || evaluators[0] === null || Array.isArray(evaluators[0])) throw new Error('Missing fixture reviewer')
  evaluators[0].model = 'fixture-review-model'
  const saved = await controller.save(0, config)
  await expect(controller.start({ action: 'apply', revision: saved.revision, stopConfirmed: true })).rejects.toThrow('local trajectory collector')
  expect((await controller.view()).runtime.phase).toBe('stopped')
})
