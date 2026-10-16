// @vitest-environment jsdom
import assert from 'node:assert/strict'
import { act, fireEvent } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { CourseView } from '../src/types.ts'
import type { PageFace, PageState } from '../src/client/model.ts'
import type { Selection } from '../src/client/RuntimeSelector.tsx'
import { isolatedReady, runtimeTarget } from '../src/client/navigation.ts'
import * as Client from '../src/client/index.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  if (failures.length) throw new AggregateError(failures, 'Course navigation fixture cleanup failed')
})

function state(): PageState {
  const config = { policy: { domains: ['lab.test'] }, provider: { socketPath: '/fixture', timeoutMs: 1, maxResponseBytes: 1024 },
    guard: { pollIntervalMs: 1, targetTools: [] }, recon: {}, actionReview: {}, forwardOpenAIKey: false }
  const draft = { revision: 3, config }
  return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
    edits: {}, errors: {}, confirming: false, view: { draft, applied: draft, defaults: config, trajectoryError: false,
      runtime: { phase: 'running', prepared: true, healthy: true, appliedRevision: 3, actionReviewReady: true },
      reconEnabled: true, openAIKeyAvailable: false, versions: {}, activity: [] } }
}

it('requires observed health, review and collection readiness for the same saved and applied revision', () => {
  expect(isolatedReady(state())).toBe(true)
  const cases: PageState[] = []
  const missing = state(); delete missing.view; cases.push(missing)
  const unavailable = state(); unavailable.available = false; cases.push(unavailable)
  for (const phase of ['stopped', 'preparing', 'starting', 'stopping', 'failed'] as const) {
    const value = state(); value.view!.runtime.phase = phase; cases.push(value)
  }
  for (const flag of ['healthy', 'prepared', 'actionReviewReady'] as const) {
    const value = state(); value.view!.runtime[flag] = false; cases.push(value)
  }
  const unobservedReview = state(); delete unobservedReview.view!.runtime.actionReviewReady; cases.push(unobservedReview)
  const unobservedCollection = state(); delete unobservedCollection.view!.trajectoryError; cases.push(unobservedCollection)
  const failedCollection = state(); failedCollection.view!.trajectoryError = true; cases.push(failedCollection)
  const noApplied = state(); delete noApplied.view!.applied; cases.push(noApplied)
  const oldRuntime = state(); oldRuntime.view!.runtime.appliedRevision = 2; cases.push(oldRuntime)
  const pending = state(); pending.view!.draft = { ...pending.view!.draft, revision: 4 }; cases.push(pending)
  for (const value of cases) expect(isolatedReady(value)).toBe(false)
})

it('restores only same-origin locations inside the requested mount and pins host returns to management', () => {
  const origin = 'http://native.test'
  expect(runtimeTarget('local', null, origin)).toBe('/?course-management=1')
  expect(runtimeTarget('local', '/?page=models#route', origin)).toBe('/?page=models&course-management=1#route')
  expect(runtimeTarget('course', '/runtimes/course/?session=one#message', origin)).toBe('/runtimes/course/?session=one#message')
  for (const saved of ['https://attacker.test/', '//attacker.test/', '/\\attacker.test/', 'http://[invalid']) {
    expect(runtimeTarget('local', saved, origin)).toBe('/?course-management=1')
    expect(runtimeTarget('course', saved, origin)).toBe('/runtimes/course/')
  }
  for (const saved of ['/', '/runtimes/other/', '/runtimes/course/../../']) expect(runtimeTarget('course', saved, origin)).toBe('/runtimes/course/')
  expect(runtimeTarget('local', '/runtimes/course/', origin)).toBe('/?course-management=1')
})

function selection(value: Record<string, unknown>): asserts value is Record<string, unknown> & Selection {
  assert(typeof value.select === 'function' && (value.selected === 'local' || value.selected === 'course'))
  assert(value.hooks !== null && typeof value.hooks === 'object')
}
function editor(value: Record<string, unknown>): asserts value is Record<string, unknown> & PageFace {
  assert(typeof value.refresh === 'function' && value.hooks !== null && typeof value.hooks === 'object')
}

async function fixture(path = '/', allowHostResearch = false, ready = false) {
  const url = new URL(path, 'http://native.test'), assign = vi.fn(), openBundle = vi.fn()
  const storage = new Map<string, string>()
  let view: CourseView = structuredClone(state().view!)
  if (!ready) view.runtime.healthy = false
  vi.stubGlobal('location', { origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash, assign })
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value) } })
  vi.stubGlobal('__DSH_COURSE_RUNTIME_CONFIG__', { allowHostResearch })
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, options?: RequestInit) => {
    expect(input).toBe('http://native.test/course-runtime/status')
    expect(options).toMatchObject({ credentials: 'same-origin' })
    return Response.json(view)
  }))
  const bench = await SlotTestRuntime.create(); cleanups.push(() => bench.dispose())
  const locale = new LocaleRuntime(bench.ctx); bench.ctx.provide('locale', locale); bench.slots.installLocale(locale); locale.setLocale('en')
  bench.ctx.provide('pluginNavigation', { openBundle })
  await bench.declare({ 'plugins.bundle.config': { kind: 'keyed', scope: 'root' }, 'sidebar.runtime': { kind: 'single', scope: 'root' } })
  const feature = await bench.mount(Client)
  const entry = bench.slots.entries('sidebar.runtime')[0]!, face = entry.inject!(); selection(face)
  const page = bench.slots.entries('plugins.bundle.config')[0]!.inject!(); editor(page)
  await vi.waitFor(() => { expect(page.hooks.course.getSnapshot().available).toBe(true) })
  return { bench, feature, locale, assign, openBundle, storage, face, page, publish: async (next: CourseView) => {
    const settled = Promise.withResolvers<undefined>()
    // Response.json decodes a new object; observe the committed response rather
    // than an unchanged field so repeated identical status replies are covered.
    const previous = page.hooks.course.getSnapshot().view
    const stop = page.hooks.course.subscribe(() => {
      const current = page.hooks.course.getSnapshot().view
      if (current !== previous && current?.runtime.healthy === next.runtime.healthy) settled.resolve(undefined)
    })
    try { view = next; await act(async () => { page.refresh(); await settled.promise }) } finally { stop() }
  } }
}

it('opens setup by default, rejects unready selection, then admits only the observed isolated runtime', async () => {
  const b = await fixture()
  const body = b.bench.renderSlot('sidebar.runtime', {})
  expect(body.view.getByRole('option', { name: 'Host management' })).toBeTruthy()
  expect(body.view.getByRole('option', { name: 'Isolated Linux' })).toHaveProperty('disabled', true)
  expect(body.view.getByRole('status').textContent).toContain('Set up and apply')
  expect(b.openBundle).toHaveBeenCalledWith('@deepseek-ai/dsh-experimental-network-scope-bundle')
  b.face.select('course'); expect(b.assign).not.toHaveBeenCalled()
  await b.publish(structuredClone(state().view!))
  expect(b.assign).toHaveBeenCalledExactlyOnceWith('/runtimes/course/')
  expect(body.view.getByRole('option', { name: 'Isolated Linux' })).toHaveProperty('disabled', false)
  expect(body.view.queryByRole('status')).toBeNull()
  expect(b.storage.get('dsh.runtime.location.local')).toBe('/')
  await b.publish(structuredClone(state().view!)); expect(b.assign).toHaveBeenCalledTimes(1)
  await act(async () => { b.locale.setLocale('zh') })
  expect(body.view.getByRole('option', { name: '主机管理' })).toBeTruthy()
  expect(body.view.getByRole('option', { name: '隔离 Linux' })).toBeTruthy()
  await b.feature.dispose()
  expect(b.bench.slots.entries('sidebar.runtime')).toEqual([])
  expect(b.bench.slots.entries('plugins.bundle.config')).toEqual([])
})

it('keeps explicit management accessible without granting host research or losing isolated navigation', async () => {
  const b = await fixture('/?course-management=1', false, true)
  expect(b.openBundle).toHaveBeenCalledOnce(); expect(b.assign).not.toHaveBeenCalled()
  b.storage.set('dsh.runtime.location.course', '/runtimes/course/?session=existing')
  const body = b.bench.renderSlot('sidebar.runtime', {})
  fireEvent.change(body.view.getByRole('combobox'), { target: { value: 'course' } })
  expect(b.assign).toHaveBeenCalledExactlyOnceWith('/runtimes/course/?session=existing')
})

it('returns from the isolated client to explicit native administration and never rewrites the execution mount', async () => {
  const b = await fixture('/runtimes/course/?session=existing', false, true)
  expect(b.openBundle).not.toHaveBeenCalled(); expect(b.assign).not.toHaveBeenCalled()
  b.storage.set('dsh.runtime.location.local', '/?page=settings')
  b.face.select('local')
  expect(b.assign).toHaveBeenCalledExactlyOnceWith('/?page=settings&course-management=1')
  expect(b.storage.get('dsh.runtime.location.course')).toBe('/runtimes/course/?session=existing')
})

it('honors only the explicit instructor host escape and remains usable when browser storage is unavailable', async () => {
  const b = await fixture('/', true, true)
  expect(b.openBundle).not.toHaveBeenCalled(); expect(b.assign).not.toHaveBeenCalled()
  vi.stubGlobal('sessionStorage', { getItem: () => { throw new Error('Storage disabled') }, setItem: () => { throw new Error('Storage disabled') } })
  b.face.select('local'); expect(b.assign).not.toHaveBeenCalled()
  b.face.select('course'); expect(b.assign).toHaveBeenCalledExactlyOnceWith('/runtimes/course/')
})

it('owns the optional recon editor independently and withdraws it without changing the scope editor', async () => {
  const b = await fixture('/?course-management=1')
  const scope = b.bench.slots.entries('plugins.bundle.config')[0]
  const release = b.bench.ctx.courseRuntimeUi.registerRecon()
  expect(b.bench.slots.entries('plugins.bundle.config')).toHaveLength(2)
  const recon = b.bench.slots.entries('plugins.bundle.config').find(row => row !== scope)
  assert(recon?.inject)
  const face = recon.inject(); editor(face)
  expect(face.hooks.course.getSnapshot().dirty).toBe(false)
  release()
  expect(b.bench.slots.entries('plugins.bundle.config')).toHaveLength(1)
})
