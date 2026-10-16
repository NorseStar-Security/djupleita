/** The staged editor owns unsaved edits, resets, and revision-fenced writes. */
import { expect, it, vi } from 'vitest'
import { PageModel } from '../src/client/model.ts'
import { scopeFields } from '../src/client/fields.ts'
import type { CourseView } from '../src/types.ts'

it('discards unsaved changes, resets to defaults, and keeps invalid fields out of saves', async () => {
  const config = { policy: { domains: ['saved.test'] }, provider: { socketPath: '/fixture', timeoutMs: 3, maxResponseBytes: 10 }, guard: { pollIntervalMs: 1, targetTools: [] }, recon: {}, actionReview: {}, forwardOpenAIKey: false }
  const view: CourseView = { draft: { revision: 7, config }, defaults: { ...config, policy: { domains: ['default.test'] } }, runtime: { phase: 'stopped', healthy: false, prepared: true }, reconEnabled: true, openAIKeyAvailable: false, versions: {}, activity: [] }
  const writes: unknown[] = []
  const fetchMock = vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') { writes.push(JSON.parse(typeof options.body === 'string' ? options.body : '')); return new Response(JSON.stringify({ revision: 8, config }), { status: 200 }) }
    return new Response(JSON.stringify(view), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const model = new PageModel('http://localhost/')
  try {
    await vi.waitFor(() => { expect(model.store.getSnapshot().available).toBe(true) })
    const face = model.face(), domains = scopeFields[0]!, ports = scopeFields.find(row => row.path === 'policy.ports')!
    face.edit(domains.path, 'unsaved.test'); expect(face.fieldText(domains)).toBe('unsaved.test')
    face.discard(); expect(face.fieldText(domains)).toBe('saved.test')
    face.reset(domains); expect(face.fieldText(domains)).toBe('default.test')
    const infrastructure = scopeFields.find(row => row.path === 'policy.infrastructure')!
    face.edit(infrastructure.path, '{"api.openai.com":{"methods":["HEAD"],"paths":["/existing"]}}')
    face.include('api.openai.com')
    expect(JSON.parse(face.fieldText(infrastructure))).toMatchObject({ 'api.openai.com': { methods: ['HEAD', 'GET', 'POST'], paths: ['/existing', '/v1/models', '/v1/chat/completions', '/v1/responses'] } })
    expect(writes).toHaveLength(0)
    face.edit(ports.path, '{invalid'); face.save()
    expect(model.store.getSnapshot().invalid).toBe(true); expect(writes).toHaveLength(0)
    face.edit(ports.path, '{"http":[80],"https":[443]}'); face.save()
    await vi.waitFor(() => { expect(writes).toHaveLength(1) })
    expect(writes[0]).toMatchObject({ revision: 7, config: { policy: { domains: ['default.test'] } } })
  } finally { model.dispose(); vi.unstubAllGlobals() }
})

function baseline(revision: number, domain = 'saved.test'): CourseView {
  const config = { policy: { domains: [domain] }, provider: { socketPath: '/fixture', timeoutMs: 3, maxResponseBytes: 10 },
    guard: { pollIntervalMs: 1, targetTools: [] }, recon: {}, actionReview: {}, forwardOpenAIKey: false }
  return { draft: { revision, config }, defaults: config, runtime: { phase: 'stopped', healthy: false, prepared: true },
    reconEnabled: true, openAIKeyAvailable: false, versions: {}, activity: [] }
}
function response(value: unknown): Response { return new Response(JSON.stringify(value), { status: 200 }) }

it('retains a newer saved revision when an already-running poll returns an older draft', async () => {
  const pollEntered = Promise.withResolvers<undefined>(), pollReply = Promise.withResolvers<Response>()
  const saveEntered = Promise.withResolvers<undefined>(), saveReply = Promise.withResolvers<Response>()
  const writes: unknown[] = []
  let polls = 0
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, options?: RequestInit) => {
    if (options?.method === 'POST') {
      writes.push(JSON.parse(typeof options.body === 'string' ? options.body : ''))
      saveEntered.resolve(undefined)
      return writes.length === 1 ? saveReply.promise : response(baseline(9, 'next.test').draft)
    }
    if (++polls === 2) { pollEntered.resolve(undefined); return pollReply.promise }
    return response(baseline(writes.length > 1 ? 9 : writes.length ? 8 : 7, writes.length > 1 ? 'next.test' : writes.length ? 'new.test' : 'saved.test'))
  }))
  const model = new PageModel('http://localhost/')
  let poll: Promise<void> | undefined
  try {
    await vi.waitFor(() => { expect(model.store.getSnapshot().available).toBe(true) })
    poll = model.refresh()
    await pollEntered.promise
    const face = model.face(), domains = scopeFields[0]!
    face.edit(domains.path, 'new.test'); face.save()
    await saveEntered.promise
    expect(model.store.getSnapshot().saving).toBe(true)
    saveReply.resolve(response(baseline(8, 'new.test').draft))
    await vi.waitFor(() => { expect(model.store.getSnapshot().saving).toBe(false) })
    expect(model.store.getSnapshot()).toMatchObject({ dirty: false, view: { draft: { revision: 8 } } })
    pollReply.resolve(response(baseline(7)))
    await poll
    expect(model.store.getSnapshot()).toMatchObject({ dirty: false, view: { draft: { revision: 8, config: { policy: { domains: ['new.test'] } } } } })
    expect(face.fieldText(domains)).toBe('new.test')
    face.edit(domains.path, 'next.test')
    await model.refresh()
    expect(face.fieldText(domains)).toBe('next.test')
    face.save()
    await vi.waitFor(() => { expect(model.store.getSnapshot().saving).toBe(false); expect(writes).toHaveLength(2) })
    expect(writes[1]).toMatchObject({ revision: 8, config: { policy: { domains: ['next.test'] } } })
  } finally {
    model.dispose(); saveReply.resolve(response(baseline(8, 'new.test').draft)); pollReply.resolve(response(baseline(7)))
    await poll; vi.unstubAllGlobals()
  }
})

it('withdraws readiness after a failed poll and ignores a response completing after disposal', async () => {
  const pending = Promise.withResolvers<Response>(), entered = Promise.withResolvers<undefined>()
  let calls = 0
  let signal: AbortSignal | undefined
  vi.stubGlobal('fetch', vi.fn((_url: unknown, options?: RequestInit) => {
    calls++
    if (calls === 1) return Promise.resolve(response(baseline(7)))
    if (calls === 2) return Promise.reject(new Error('Management unavailable'))
    signal = options?.signal ?? undefined
    entered.resolve(undefined)
    return pending.promise
  }))
  const model = new PageModel('http://localhost/')
  let refresh: Promise<void> | undefined
  try {
    await vi.waitFor(() => { expect(model.store.getSnapshot().available).toBe(true) })
    await model.refresh()
    expect(model.store.getSnapshot()).toMatchObject({ available: false, failed: true, view: { draft: { revision: 7 } } })
    refresh = model.refresh(); await entered.promise
    const stopped = model.store.getSnapshot()
    model.dispose(); expect(signal?.aborted).toBe(true)
    pending.resolve(response(baseline(99)))
    await refresh
    expect(model.store.getSnapshot()).toBe(stopped)
  } finally { model.dispose(); pending.resolve(response(baseline(99))); await refresh; vi.unstubAllGlobals() }
})
