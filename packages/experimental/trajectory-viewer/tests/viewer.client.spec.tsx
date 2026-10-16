// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ComponentProps } from 'react'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CollectedRecord, CollectorIdentity } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type { ProjectionErrorCode, ProjectionId, TraceSummary, TraceSpan } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'
import type { ViewerValue } from '../src/wire.ts'
import { Trajectories, TrajectoryIcon } from '../src/client/viewer.tsx'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const identity: CollectorIdentity = {
  installationId: brandString<CollectorIdentity['installationId']>('student-vm'),
  studentId: brandString<CollectorIdentity['studentId']>('student-one'),
  cohortId: brandString<CollectorIdentity['cohortId']>('course590'),
}
const trace: TraceSummary = {
  traceId: brandString<TraceSummary['traceId']>('a'.repeat(32)), rootSpanId: brandString<TraceSummary['rootSpanId']>('b'.repeat(16)),
  cursor: 2, identity, sessionId: SessionId('research'), turn: 1, name: 'Turn 1', startTime: 1000, endTime: 1100,
  status: 'blocked', parentSessionId: SessionId('parent-research'), parentTraceId: null, firstCursor: 2, lastCursor: 5,
}
const root: TraceSpan = {
  ...trace, spanId: trace.rootSpanId, parentSpanId: null, kind: 'turn', cursor: 1, completionCursor: 1,
  firstRecordId: brandString<TraceSpan['firstRecordId']>('record-two'),
  lastRecordId: brandString<TraceSpan['lastRecordId']>('record-five'), attributes: {},
}
const denied: TraceSpan = {
  ...root, spanId: brandString<TraceSpan['spanId']>('c'.repeat(16)), parentSpanId: root.spanId, cursor: 2, kind: 'scope',
  name: 'Scope blocked: widgets.test', attributes: { domain: 'widgets.test', decision: 'deny', reason: 'outside acme.test scope' },
}
const record: CollectedRecord = {
  id: brandString<CollectedRecord['id']>('record-three'), sessionId: trace.sessionId,
  sequence: 3, type: 'scope/decision', timestamp: 1050,
  content: '{"domain":"widgets.test","untrusted":"<script>alert(1)</script>"}', cursor: 4,
  identity, sha256: 'a'.repeat(64), receivedAt: 1051,
}

function mount(options: {
  state?: 'live' | 'loading' | 'failed' | 'none'
  values?: boolean
  more?: boolean
  empty?: boolean
  dictionary?: typeof en | typeof zh
  selectedTrace?: TraceSummary
  spans?: TraceSpan[]
  records?: CollectedRecord[]
  missingTrace?: boolean
  projectionError?: ProjectionErrorCode
  pages?: Partial<Record<'status' | 'traces' | 'detail' | 'records', ViewerValue>>
} = {}) {
  const addresses: string[] = []
  const selectedTrace = options.selectedTrace ?? trace
  const props = {
    t: makeTranslate(options.dictionary ?? en),
    useResource(address: string) {
      addresses.push(address)
      const kind = new URL(address).pathname.slice(1)
      const values: Record<string, ViewerValue> = {
        status: { kind: 'status', page: {
          collector: { records: 5, artifacts: 0, contentBytes: 500, lastCursor: 5,
            exportedCursor: 0, revokedInstallations: 0, exportDestination: null },
          projection: { projectionId: brandString<ProjectionId>('projection-one'), state: 'idle', collectorCursor: 5,
            sourceCursor: 5, traces: 1, spans: 2, completedCursor: 2,
            ...options.projectionError === undefined ? {} : { errorCode: options.projectionError } },
        } },
        traces: { kind: 'traces', page: { traces: options.empty ? [] : [selectedTrace], nextCursor: 2, hasMore: options.more ?? false } },
        detail: { kind: 'detail', page: { trace: options.missingTrace ? undefined : selectedTrace,
          spans: options.spans ?? [root, denied], nextCursor: 2, hasMore: options.more ?? false } },
        records: { kind: 'records', page: { records: options.records ?? [record], nextCursor: 4, hasMore: options.more ?? false } },
        ...options.pages,
      }
      return { status: options.state ?? 'live', value: options.values === false ? undefined : values[kind], failure: undefined }
    },
  } as ComponentProps<typeof Trajectories>
  const view = render(<Trajectories {...props} />)
  return { ...view, addresses }
}

describe('Trajectories bounded global panel', () => {
  it('shows collector progress, a nested scope decision and exact inert source records', () => {
    const { container } = mount()
    expect(screen.getByText('Indexed 5 / 5 records')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    expect(screen.getByText('Scope blocked: widgets.test')).toBeTruthy()
    expect(screen.getByText(/outside acme.test scope/)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: 'Inspect source records' })[1] as HTMLElement)
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
    expect(container.querySelector('script')).toBeNull()
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this record page' }), { target: { value: 'nonexistent-domain' } })
    expect(screen.getByText('No records on this page.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close source records' }))
    expect(screen.queryByRole('textbox', { name: 'Search this record page' })).toBeNull()
  })
  it('applies identity/search/status filters without loading a transcript and pauses follow', () => {
    const { addresses } = mount()
    fireEvent.change(screen.getByRole('textbox', { name: 'Installation' }), { target: { value: 'installation-two' } })
    fireEvent.change(screen.getByRole('textbox', { name: 'Search traces' }), { target: { value: 'widgets.test' } })
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }))
    fireEvent.click(screen.getByRole('button', { name: 'Blocked' }))
    const query = new URL(addresses.filter(value => value.includes('/traces')).at(-1) as string)
    expect(query.searchParams.get('installationId')).toBe('installation-two')
    expect(query.searchParams.get('search')).toBe('widgets.test')
    expect(query.searchParams.get('status')).toBe('blocked')
    fireEvent.click(screen.getByRole('switch', { name: 'Live follow' }))
    expect(screen.getByText('Paused')).toBeTruthy()
    expect(new URL(addresses.at(-1) as string).searchParams.get('follow')).toBe('0')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(new URL(addresses.at(-1) as string).searchParams.get('revision')).toBe('1')
  })
  it('replaces pages instead of growing the DOM, and offers timeline/source navigation', () => {
    const { addresses } = mount({ more: true })
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(screen.getAllByRole('button', { name: /Turn 1.*Blocked/ })).toHaveLength(1)
    expect(new URL(addresses.filter(value => value.includes('/traces')).at(-1) as string).searchParams.get('after')).toBe('2')
    fireEvent.click(screen.getByRole('button', { name: 'First page' }))
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    expect(screen.getByRole('button', { name: /Scope blocked: widgets.test/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Child sessions' }))
    expect(new URL(addresses.filter(value => value.includes('/traces')).at(-1) as string).searchParams.get('parentSessionId')).toBe('research')
  })
  it('presents unavailable, stale, loading, empty and Chinese states', () => {
    const failed = mount({ state: 'failed', values: false })
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('Collector unavailable')
    failed.unmount()
    const stale = mount({ state: 'failed' })
    expect(screen.getAllByRole('alert')[0]?.textContent).toContain('last received page')
    stale.unmount()
    const loading = mount({ state: 'loading', values: false })
    expect(screen.getAllByRole('status')).toHaveLength(2)
    loading.unmount()
    const empty = mount({ empty: true })
    expect(screen.getByText('No traces match these filters.')).toBeTruthy()
    empty.unmount()
    mount({ dictionary: zh })
    expect(screen.getByRole('heading', { name: '轨迹' })).toBeTruthy()
    render(<TrajectoryIcon size={16} />)
  })
  it('shows a missing provider and terminal projection failure without hiding the visible operation', () => {
    const absent = mount({ state: 'none', values: false })
    expect(screen.getAllByRole('alert').map(node => node.textContent)).toEqual([
      en.unavailable, en.unavailable,
    ])
    absent.unmount()
    mount({ projectionError: 'PROJECTION_SOURCE' })
    expect(screen.getByRole('alert').textContent).toBe('PROJECTION_SOURCE')
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
  })
  it('keeps endpoint values isolated and shows a missing trace instead of treating another resource page as detail', () => {
    const foreign: ViewerValue = { kind: 'records', page: { records: [], nextCursor: 0, hasMore: false } }
    const unavailable = mount({ pages: { status: foreign, traces: foreign } })
    expect(screen.queryByText('Indexed 5 / 5 records')).toBeNull()
    expect(screen.queryByRole('button', { name: /Turn 1/ })).toBeNull()
    unavailable.unmount()
    const noDetail = mount({ pages: { detail: foreign } })
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    expect(screen.queryByRole('button', { name: 'Original records' })).toBeNull()
    noDetail.unmount()
    mount({ missingTrace: true })
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    expect(screen.getByText('This trace is not available.')).toBeTruthy()
  })
  it('preserves installation scope for parent and child navigation and resets independent detail/source cursors', () => {
    const { addresses } = mount({ more: true })
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    const detailPager = screen.getAllByRole('navigation')[1]!
    fireEvent.click(within(detailPager).getByRole('button', { name: 'Next page' }))
    expect(new URL(addresses.filter(value => value.includes('/detail')).at(-1)!).searchParams.get('after')).toBe('2')
    fireEvent.click(within(detailPager).getByRole('button', { name: 'First page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    fireEvent.click(screen.getByRole('button', { name: /Scope blocked: widgets.test/ }))
    const rawPager = screen.getAllByRole('navigation')[2]!
    fireEvent.click(within(rawPager).getByRole('button', { name: 'Next page' }))
    expect(new URL(addresses.filter(value => value.includes('/records')).at(-1)!).searchParams.get('after')).toBe('4')
    fireEvent.click(within(rawPager).getByRole('button', { name: 'First page' }))
    expect(new URL(addresses.filter(value => value.includes('/records')).at(-1)!).searchParams.get('after')).toBe('0')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search this record page' }), { target: { value: 'SCOPE/DECISION' } })
    expect(screen.getByText(/<script>alert\(1\)<\/script>/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Parent session/ }))
    const parent = new URL(addresses.filter(value => value.includes('/traces')).at(-1)!)
    expect(parent.searchParams.get('sessionId')).toBe('parent-research')
    expect(parent.searchParams.get('installationId')).toBe(identity.installationId)
    expect(parent.searchParams.has('parentSessionId')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Child sessions' }))
    const children = new URL(addresses.filter(value => value.includes('/traces')).at(-1)!)
    expect(children.searchParams.get('parentSessionId')).toBe(trace.sessionId)
    expect(children.searchParams.get('installationId')).toBe(identity.installationId)
    expect(children.searchParams.has('sessionId')).toBe(false)
  })
  it('shows running spans, orphan/self roots and siblings without fabricating parents or negative timeline geometry', () => {
    const running: TraceSummary = { ...trace, parentSessionId: null, status: 'running', endTime: null }
    const sibling: TraceSpan = { ...denied, spanId: brandString<TraceSpan['spanId']>('d'.repeat(16)), name: 'Sibling tool' }
    const orphan: TraceSpan = { ...denied, spanId: brandString<TraceSpan['spanId']>('e'.repeat(16)),
      parentSpanId: brandString<TraceSpan['spanId']>('f'.repeat(16)), name: 'Orphan tool', startTime: 900, endTime: null }
    const self: TraceSpan = { ...denied, spanId: brandString<TraceSpan['spanId']>('1'.repeat(16)),
      parentSpanId: brandString<TraceSpan['spanId']>('1'.repeat(16)), name: 'Self-linked tool', startTime: 1200, endTime: null }
    const { container } = mount({ selectedTrace: running, spans: [{ ...root, endTime: null, status: 'running' }, denied, sibling, orphan, self] })
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Running/ }))
    expect(screen.getByText('Sibling tool')).toBeTruthy()
    expect(screen.getByText('Orphan tool')).toBeTruthy()
    expect(screen.getByText('Self-linked tool')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Parent session/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    expect(screen.getByRole('button', { name: /Orphan tool/ })).toBeTruthy()
    expect(container.innerHTML).not.toContain('NaN')
    fireEvent.click(screen.getByRole('button', { name: 'Execution tree' }))
    expect(screen.getByText('Sibling tool')).toBeTruthy()
  })
  it('renders empty execution pages and refuses to reuse a wrong-kind page as original records', () => {
    const empty = mount({ spans: [], records: [] })
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    expect(screen.queryByRole('button', { name: 'Inspect source records' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Timeline' }))
    fireEvent.click(screen.getByRole('button', { name: 'Original records' }))
    expect(screen.getByText('No records on this page.')).toBeTruthy()
    empty.unmount()
    mount({ pages: { records: { kind: 'traces', page: { traces: [], nextCursor: 0, hasMore: false } } } })
    fireEvent.click(screen.getByRole('button', { name: /Turn 1.*Blocked/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Original records' }))
    expect(screen.queryByText('No records on this page.')).toBeNull()
    expect(screen.queryByText(/<script>alert\(1\)<\/script>/)).toBeNull()
  })
})
