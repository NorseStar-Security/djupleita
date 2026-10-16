import { afterEach, describe, expect, it, vi } from 'vitest'
import { provider } from '../src/client/resources.ts'
import { parsePage } from '../src/wire.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const page = { traces: [], nextCursor: 0, hasMore: false }

describe('bounded trajectory resource transport', () => {
  it('uses only same-origin read routes and emits a complete one-shot page when paused', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page)))
    vi.stubGlobal('fetch', request)
    const frames = []
    for await (const frame of provider(1500).open('dsh-resource://trajectory/traces?follow=0&revision=7&limit=40', { signal: new AbortController().signal })) frames.push(frame)
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]).toEqual(['api/trajectory-viewer/traces?limit=40', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store' })])
    expect(frames).toEqual([{ ok: true, value: { kind: 'traces', page } }])
  })
  it('uses the native management route while viewing Protected', async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page)))
    vi.stubGlobal('fetch', request)
    for await (const _frame of provider(1500, '/api/trajectory-viewer/').open('dsh-resource://trajectory/traces?follow=0', { signal: new AbortController().signal })) { /* drain the single response */ }
    expect(request.mock.calls[0]?.[0]).toBe('/api/trajectory-viewer/traces')
  })
  it('keeps failures explicit and refuses malformed and oversized complete responses', async () => {
    for (const response of [new Response('{}', { status: 503 }), new Response('{bad'), new Response(JSON.stringify({ ...page, traces: [{}] })), new Response('x'.repeat(2097153)), new Response(null)]) {
      vi.stubGlobal('fetch', async () => response)
      const result = await provider(1500).open('dsh-resource://trajectory/traces', { signal: new AbortController().signal })[Symbol.asyncIterator]().next()
      expect(result.value).toMatchObject({ ok: false, error: { code: 'trajectory-viewer/unavailable' } })
    }
    expect(() => parsePage('unknown', {})).toThrow()
    const invalid = provider(1500).open('dsh-resource://trajectory/not-a-route', { signal: new AbortController().signal })[Symbol.asyncIterator]()
    expect((await invalid.next()).value).toMatchObject({ ok: false })
    expect((await invalid.next()).done).toBe(true)
  })
  it('polls only while held and aborts in-flight work when the resource releases', async () => {
    vi.useFakeTimers()
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(page)))
    vi.stubGlobal('fetch', request)
    const lifetime = new AbortController()
    const iterator = provider(1500).open('dsh-resource://trajectory/traces?follow=1', { signal: lifetime.signal })[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ ok: true })
    const second = iterator.next()
    await vi.advanceTimersByTimeAsync(1500)
    expect((await second).value).toMatchObject({ ok: true })
    const end = iterator.next()
    lifetime.abort()
    expect((await end).done).toBe(true)
    expect(request).toHaveBeenCalledTimes(2)
  })
  it('does not start a released resource and cancels a pending fetch without emitting a stale failure', async () => {
    const released = new AbortController()
    released.abort()
    const unused = vi.fn()
    vi.stubGlobal('fetch', unused)
    expect(await provider(1000).open('dsh-resource://trajectory/status', { signal: released.signal })[Symbol.asyncIterator]().next())
      .toEqual({ done: true, value: undefined })
    expect(unused).not.toHaveBeenCalled()

    const lifetime = new AbortController()
    let accepted = () => {}
    const started = new Promise<void>((resolve) => { accepted = resolve })
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
      accepted()
    }))
    const pending = provider(1000).open('dsh-resource://trajectory/status', { signal: lifetime.signal })[Symbol.asyncIterator]().next()
    await started
    lifetime.abort()
    expect(await pending).toEqual({ done: true, value: undefined })
  })
  it('reports a fetch deadline and releases all timers when the one-shot request settles', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', (_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => { reject(new Error('deadline')) }, { once: true })
    }))
    const iterator = provider(1000).open('dsh-resource://trajectory/status', { signal: new AbortController().signal })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.advanceTimersByTimeAsync(10000)
    expect((await pending).value).toMatchObject({ ok: false, error: { code: 'trajectory-viewer/unavailable' } })
    expect((await iterator.next()).done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('suppresses a completed response released before publication and interrupts an established polling delay', async () => {
    const lifetime = new AbortController()
    vi.stubGlobal('fetch', async () => {
      lifetime.abort()
      return new Response(JSON.stringify(page))
    })
    const cancelled = provider(1000).open('dsh-resource://trajectory/traces?follow=1', { signal: lifetime.signal })[Symbol.asyncIterator]()
    expect((await cancelled.next()).done).toBe(true)

    vi.useFakeTimers()
    const delayed = new AbortController()
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(page)))
    const iterator = provider(3000).open('dsh-resource://trajectory/traces?follow=1', { signal: delayed.signal })[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ ok: true })
    const pending = iterator.next()
    await vi.advanceTimersByTimeAsync(1)
    expect(vi.getTimerCount()).toBe(1)
    delayed.abort()
    expect((await pending).done).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
