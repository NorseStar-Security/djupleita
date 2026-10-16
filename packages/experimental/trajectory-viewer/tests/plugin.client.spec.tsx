// @vitest-environment jsdom
import { act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import * as Resources from '@deepseek-ai/dsh-client-resources/client'
import * as Viewer from '../src/client/index.ts'
import { Config } from '../src/config.ts'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  if (failures.length) throw new AggregateError(failures, 'trajectory client fixture cleanup failed')
})

async function runtime() {
  const bench = await SlotTestRuntime.create()
  cleanups.push(() => bench.dispose())
  const locale = new LocaleRuntime(bench.ctx)
  bench.ctx.provide('locale', locale)
  bench.slots.installLocale(locale)
  locale.setLocale('en')
  await bench.mount(Resources)
  return { bench, locale }
}

function transport() {
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    expect(url.startsWith('api/trajectory-viewer/')).toBe(true)
    expect(init).toMatchObject({ credentials: 'same-origin', cache: 'no-store' })
    const value = url.includes('/status') ? {
      collector: { records: 0, artifacts: 0, contentBytes: 0, lastCursor: 0, exportedCursor: 0,
        revokedInstallations: 0, exportDestination: null },
      projection: { projectionId: 'generation', state: 'idle', collectorCursor: 0, sourceCursor: 0,
        traces: 0, spans: 0, completedCursor: 0 },
    } : { traces: [], nextCursor: 0, hasMore: false }
    return Response.json(value)
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

describe('trajectory viewer client plugin with production slots, locale and resources', () => {
  it('registers localized root panels only under declared slots and withdraws all contributions on unload', async () => {
    vi.stubGlobal('__DSH_TRAJECTORY_VIEWER_CONFIG__', undefined)
    const fetcher = transport()
    const { bench, locale } = await runtime()
    const t = locale.bind('trajectory.viewer')
    const source = bench.ctx.resources.source('dsh-resource://trajectory/traces?follow=0')
    expect(source.getSnapshot().status).toBe('none')
    expect(Object.keys(Viewer).sort()).toEqual(['apply', 'inject'])
    expect(Viewer.inject).toEqual(['slots', 'locale', 'resources'])
    const feature = await bench.mount(Viewer)
    expect(t('panel')).toBe('Trajectories')
    expect(source.getSnapshot().status).toBe('loading')
    expect(bench.slots.entries('main')).toEqual([])
    expect(bench.slots.entries('sidebar.panellist')).toEqual([])
    await bench.declare({
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    })
    expect(bench.slots.entries('main')).toMatchObject([{ options: { key: 'trajectories' }, locale: 'trajectory.viewer' }])
    const navigation = bench.slots.entries('sidebar.panellist')[0]!
    expect(navigation).toMatchObject({ options: { id: 'trajectories', order: 10 }, locale: 'trajectory.viewer' })
    expect(resolveSlotLabel(navigation.options.label)).toBe('Trajectories')
    const icon = bench.renderSlot('sidebar.panellist', { size: 18, active: true }, { only: 'trajectories' })
    expect(icon.container.querySelector('svg')).not.toBeNull()
    const body = bench.renderSlot('main', {}, { entryKey: 'trajectories' })
    expect(body.view.getByRole('heading', { name: 'Trajectories' })).toBeTruthy()
    expect(await body.view.findByText('No traces match these filters.')).toBeTruthy()
    expect(body.view.getByText('Indexed 0 / 0 records')).toBeTruthy()
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('api/trajectory-viewer/traces'), expect.any(Object))
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('api/trajectory-viewer/status'), expect.any(Object))
    await act(async () => { locale.setLocale('zh') })
    expect(resolveSlotLabel(navigation.options.label)).toBe('轨迹')
    expect(body.view.getByRole('heading', { name: '轨迹' })).toBeTruthy()
    await feature.dispose()
    expect(bench.slots.entries('main')).toEqual([])
    expect(bench.slots.entries('sidebar.panellist')).toEqual([])
    expect(source.getSnapshot().status).toBe('none')
    expect(t('panel')).toBe('panel')
    expect(body.container.querySelector('[data-trajectory-viewer]')).toBeNull()
    expect(icon.container.querySelector('svg')).toBeNull()
    const replacement = await bench.mount(Viewer)
    expect(bench.slots.entries('main')).toHaveLength(1)
    expect(bench.slots.entries('sidebar.panellist')).toHaveLength(1)
    expect(t('panel')).toBe('轨迹')
    await replacement.dispose()
    expect(source.getSnapshot().status).toBe('none')
  })

  it.each([
    { injected: undefined, interval: 1500 },
    { injected: { pollIntervalMs: 3000 }, interval: 3000 },
  ])('uses the validated deployment cadence $interval ms for real live resource reads', async ({ injected, interval }) => {
    vi.useFakeTimers()
    vi.stubGlobal('__DSH_TRAJECTORY_VIEWER_CONFIG__', injected)
    const fetcher = transport()
    const { bench } = await runtime()
    const source = bench.ctx.resources.source('dsh-resource://trajectory/traces?follow=1')
    const ready = Promise.withResolvers<undefined>()
    const unsubscribe = source.subscribe(() => { if (source.getSnapshot().status === 'live') ready.resolve(undefined) })
    cleanups.push(unsubscribe)
    expect(source.getSnapshot().status).toBe('none')
    const feature = await bench.mount(Viewer)
    await ready.promise
    await vi.advanceTimersByTimeAsync(0)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(interval - 1)
    expect(fetcher).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(source.getSnapshot()).toMatchObject({ status: 'live', value: { kind: 'traces', page: { traces: [] } } })
    await feature.dispose()
    expect(source.getSnapshot().status).toBe('none')
    await vi.advanceTimersByTimeAsync(interval * 2)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves shared Host/browser defaults and keeps the configured cadence within its reviewed bounds', () => {
    expect(Config({})).toEqual({ pollIntervalMs: 1500, apiBasePath: 'api/trajectory-viewer/' })
    expect(Config({ pollIntervalMs: 1000, apiBasePath: 'api/trajectory-viewer/' })).toEqual({ pollIntervalMs: 1000, apiBasePath: 'api/trajectory-viewer/' })
    expect(Config({ pollIntervalMs: 60000, apiBasePath: 'api/trajectory-viewer/' })).toEqual({ pollIntervalMs: 60000, apiBasePath: 'api/trajectory-viewer/' })
    for (const value of [0, 999, 60001, 1500.5]) {
      expect(() => Config({ pollIntervalMs: value }), String(value)).toThrow()
    }
  })
})
