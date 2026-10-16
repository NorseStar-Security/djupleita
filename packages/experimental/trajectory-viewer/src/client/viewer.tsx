/** Pure bounded-page presentation. All reads use the framework resource hook. */
import { useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Button, Input, Pill, Switch, IconWorkspaceTreeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TraceId, TraceSummary, TraceSpan } from '@deepseek-ai/dsh-experimental-trajectory-projection/types'
import type { CollectedRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from './index.ts'
import css from './viewer.module.css'

type Props = Pick<PropsRuntime<'main'>, 'useResource'> & PropsLocale<'trajectory.viewer'>
type ResourceHook = Props['useResource']
type Translate = Props['t']
type Filters = {
  search: string
  installationId: string
  studentId: string
  cohortId: string
  sessionId: string
  status: string
  parentSessionId: string
}
const blank: Filters = { search: '', installationId: '', studentId: '', cohortId: '', sessionId: '', status: '', parentSessionId: '' }

function address(kind: string, params: Record<string, string | number | boolean>): string {
  const url = new URL(`dsh-resource://trajectory/${kind}`)
  for (const [key, value] of Object.entries(params)) if (value !== '') url.searchParams.set(key, typeof value === 'boolean' ? value ? '1' : '0' : String(value))
  return url.href
}
function Notice({ state, t }: { state: { status: string; value: unknown }; t: Translate }): ReactNode {
  if (state.status === 'failed') return <p role="alert" className={css.notice}>{t(state.value === undefined ? 'unavailable' : 'stale')}</p>
  if (state.status === 'none') return <p role="alert" className={css.notice}>{t('unavailable')}</p>
  if (state.status === 'loading') return <p role="status" className={css.muted}>{t('loading')}</p>
  return null
}
function Pager({ after, next, more, change, t }: {
  after: number
  next: number
  more: boolean
  change: (cursor: number) => void
  t: Translate
}): ReactNode {
  return <nav className={css.pager}>
    {after > 0 && <Button variant="ghost" size="sm" onClick={() => { change(0) }}>{t('first')}</Button>}
    {more && <><span className={css.muted}>{t('more')}</span><Button variant="outline" size="sm" onClick={() => { change(next) }}>{t('next')}</Button></>}
  </nav>
}
function Health({ useResource, follow, revision, t }: {
  useResource: ResourceHook
  follow: boolean
  revision: number
  t: Translate
}): ReactNode {
  const health = useResource<'trajectory'>(address('status', { follow, revision }))
  const value = health.value?.kind === 'status' ? health.value.page : undefined
  return <div><Notice state={health} t={t} />{value && <div className={css.health}>
    <span>{t('records', { count: value.collector.records })}</span><span>{t('traces', { count: value.projection.traces })}</span>
    <span>{t('spans', { count: value.projection.spans })}</span>
    <span>{t(value.projection.state)}</span><span>{t('lag', { indexed: value.projection.collectorCursor, source: value.projection.sourceCursor })}</span>
    {value.projection.errorCode && <span role="alert">{value.projection.errorCode}</span>}
  </div>}</div>
}

/**
 * Render the global read-only collector workspace with bounded independent list/detail pages.
 * @param props - standard resource and localized seats.
 * @returns the main Trajectories panel.
 */
export function Trajectories({ useResource, t }: Props): ReactNode {
  const [follow, setFollow] = useState(true)
  const [revision, setRevision] = useState(0)
  const [draft, setDraft] = useState<Filters>(blank)
  const [filters, setFilters] = useState<Filters>(blank)
  const [after, setAfter] = useState(0)
  const [selected, setSelected] = useState<TraceId | undefined>()
  const traces = useResource<'trajectory'>(address('traces', { ...filters, after, limit: 40, follow: follow && after === 0, revision }))
  const page = traces.value?.kind === 'traces' ? traces.value.page : undefined
  const filterSession = (sessionId: string, installationId: string, children = false): void => {
    const next = { ...blank, installationId, ...children ? { parentSessionId: sessionId } : { sessionId } }
    setFilters(next); setDraft(next); setAfter(0); setSelected(undefined)
  }
  return <section className={css.page} data-trajectory-viewer>
    <header className={css.header}><div><h1>{t('panel')}</h1><p className={css.muted}>{t('intro')}</p></div>
      <div className={css.controls}><Switch checked={follow} onChange={setFollow} label={t('live')} />
        {!follow && <span className={css.muted}>{t('paused')}</span>}<Button variant="outline" onClick={() => { setRevision(value => value + 1) }}>{t('refresh')}</Button></div>
    </header>
    <Health useResource={useResource} follow={follow} revision={revision} t={t} />
    <form className={css.filters} onSubmit={(event) => { event.preventDefault(); setFilters(draft); setAfter(0) }}>
      {(['search', 'installationId', 'studentId', 'cohortId', 'sessionId'] as const).map(key => <Input key={key} maxLength={256}
        aria-label={t(key === 'search' ? 'search' : key === 'installationId' ? 'installation' : key === 'studentId' ? 'student' : key === 'cohortId' ? 'cohort' : 'session')}
        placeholder={t(key === 'search' ? 'search' : key === 'installationId' ? 'installation' : key === 'studentId' ? 'student' : key === 'cohortId' ? 'cohort' : 'session')}
        value={draft[key]} onChange={(event) => { setDraft({ ...draft, [key]: event.target.value }) }} />)}
      <Button variant="outline" type="submit">{t('apply')}</Button>
    </form>
    <div className={css.controls} aria-label={t('status')}>
      {(['', 'running', 'completed', 'blocked', 'error', 'incomplete'] as const).map(status => <Pill key={status || 'all'} active={filters.status === status}
        onClick={() => { setFilters({ ...filters, status }); setDraft({ ...draft, status }); setAfter(0) }}>{t(status || 'all')}</Pill>)}
    </div>
    <div className={css.workspace}>
      <aside className={css.traceList}><Notice state={traces} t={t} />
        {page?.traces.length === 0 && <p className={css.muted}>{t('empty')}</p>}
        {page?.traces.map(trace => <button key={trace.traceId} type="button" className={css.trace} aria-pressed={selected === trace.traceId}
          aria-label={t('traceLabel', { name: trace.name, status: t(trace.status), student: trace.identity.studentId })}
          onClick={() => { setSelected(trace.traceId) }}>
          <span className={css.traceTitle}>{trace.name}</span><span data-status={trace.status}>{t(trace.status)}</span>
          <span className={css.muted}>{trace.identity.studentId} · {trace.identity.installationId}</span>
          <span className={css.mono}>{trace.sessionId}</span>
          <span className={css.muted}>{new Date(trace.startTime).toLocaleString()}</span>
        </button>)}
        {page && <Pager after={after} next={page.nextCursor} more={page.hasMore} change={setAfter} t={t} />}
      </aside>
      <div className={css.detail}>{selected === undefined ? <p className={css.muted}>{t('select')}</p>
        : <TraceDetail key={selected} traceId={selected} useResource={useResource}
          follow={follow} revision={revision} t={t} filterSession={filterSession} />}</div>
    </div>
  </section>
}

function TraceDetail({ traceId, useResource, follow, revision, t, filterSession }: {
  traceId: TraceId
  useResource: ResourceHook
  follow: boolean
  revision: number
  t: Translate
  filterSession: (session: string, installation: string, children?: boolean) => void
}): ReactNode {
  const [after, setAfter] = useState(0)
  const [mode, setMode] = useState<'tree' | 'timeline'>('tree')
  const [source, setSource] = useState<{ trace: TraceSummary; after: number } | undefined>()
  const detail = useResource<'trajectory'>(address('detail', { traceId, after, limit: 100, follow, revision }))
  const page = detail.value?.kind === 'detail' ? detail.value.page : undefined
  const trace = page?.trace
  if (!trace) return <><Notice state={detail} t={t} />{page && <p>{t('noTrace')}</p>}</>
  const inspect = (span: TraceSpan): void => { setSource({ trace, after: Math.max(0, span.firstCursor - 1) }) }
  return <><Notice state={detail} t={t} />
    <div className={css.detailHead}><h2>{trace.name}</h2><span data-status={trace.status}>{t(trace.status)}</span></div>
    <div className={css.mono}>{trace.traceId}</div>
    <div className={css.controls}>{trace.parentSessionId && <Button variant="ghost" size="sm" onClick={() => { filterSession(trace.parentSessionId as string, trace.identity.installationId) }}>{t('parent')} · {trace.parentSessionId}</Button>}
      <Button variant="ghost" size="sm" onClick={() => { filterSession(trace.sessionId, trace.identity.installationId, true) }}>{t('children')}</Button>
      <Button variant="ghost" size="sm" onClick={() => { setSource({ trace, after: Math.max(0, trace.firstCursor - 1) }) }}>{t('raw')}</Button></div>
    <div className={css.controls}>{(['tree', 'timeline'] as const).map(value => <Pill key={value} active={mode === value} onClick={() => { setMode(value) }}>{t(value)}</Pill>)}</div>
    {mode === 'tree' ? <ExecutionTree spans={page.spans} inspect={inspect} t={t} /> : <Timeline spans={page.spans} trace={trace} inspect={inspect} t={t} />}
    <Pager after={after} next={page.nextCursor} more={page.hasMore} change={setAfter} t={t} />
    {source && <RawRecords key={`${source.trace.traceId}:${source.after}`} source={source} useResource={useResource} t={t} close={() => { setSource(undefined) }} />}
  </>
}

function ExecutionTree({ spans, inspect, t }: { spans: TraceSpan[]; inspect: (span: TraceSpan) => void; t: Translate }): ReactNode {
  const tree = useMemo(() => {
    const ids = new Set(spans.map(span => span.spanId)), children = new Map<string | null, TraceSpan[]>()
    for (const span of spans) {
      const parent = span.parentSpanId !== null && ids.has(span.parentSpanId) && span.parentSpanId !== span.spanId
        ? span.parentSpanId : null
      const group = children.get(parent) ?? []; group.push(span); children.set(parent, group)
    }
    return children
  }, [spans])
  return <ol className={css.tree}>{(tree.get(null) ?? []).map(span =>
    <Step key={span.spanId} span={span} tree={tree} inspect={inspect} t={t} depth={0} />)}</ol>
}
function Step({ span, tree, inspect, t, depth }: {
  span: TraceSpan
  tree: Map<string | null, TraceSpan[]>
  inspect: (span: TraceSpan) => void
  t: Translate
  depth: number
}): ReactNode {
  const children = tree.get(span.spanId) ?? []
  return <li><details open={depth < 2}><summary>
    <span className={css.stepName}>{span.name}</span><span className={css.kind}>{span.kind}</span>
    <span data-status={span.status}>{t(span.status)}</span>{span.endTime !== null && <span className={css.muted}>{t('duration', { value: Math.max(0, span.endTime - span.startTime) })}</span>}</summary>
  <div className={css.stepBody}><Button variant="ghost" size="sm" onClick={() => { inspect(span) }}>{t('source')}</Button>
    {Object.keys(span.attributes).length > 0 && <pre className={css.raw}>{JSON.stringify(span.attributes, null, 2)}</pre>}</div>
  {children.length > 0 && depth < 100 && <ol>{children.map(child =>
    <Step key={child.spanId} span={child} tree={tree} inspect={inspect} t={t} depth={depth + 1} />)}</ol>}
  </details></li>
}
function Timeline({ spans, trace, inspect, t }: {
  spans: TraceSpan[]
  trace: TraceSummary
  inspect: (span: TraceSpan) => void
  t: Translate
}): ReactNode {
  const end = Math.max(trace.startTime + 1, trace.endTime ?? trace.startTime, ...spans.map(span => span.endTime ?? span.startTime))
  const duration = end - trace.startTime
  return <div className={css.timeline}>{spans.map((span) => {
    const left = Math.max(0, Math.min(100, (span.startTime - trace.startTime) / duration * 100))
    const width = Math.max(0.5, Math.min(100 - left, ((span.endTime ?? end) - span.startTime) / duration * 100))
    return <button key={span.spanId} type="button" className={css.timelineRow} onClick={() => { inspect(span) }} title={t('source')}>
      <span>{span.name}</span><span className={css.track}><span data-status={span.status} className={css.bar} style={{ '--trace-start': `${left}%`, '--trace-width': `${width}%` } as CSSProperties} /></span>
      <span className={css.muted}>{t('duration', { value: Math.max(0, (span.endTime ?? end) - span.startTime) })}</span>
    </button>
  })}</div>
}
function RawRecords({ source, useResource, t, close }: {
  source: { trace: TraceSummary; after: number }
  useResource: ResourceHook
  t: Translate
  close: () => void
}): ReactNode {
  const [after, setAfter] = useState(source.after), [search, setSearch] = useState('')
  const raw = useResource<'trajectory'>(address('records', { installationId: source.trace.identity.installationId, sessionId: source.trace.sessionId, after, limit: 10, follow: false }))
  const page = raw.value?.kind === 'records' ? raw.value.page : undefined
  const records = page?.records.filter(record => `${record.type}\n${record.content}`.toLowerCase().includes(search.toLowerCase())) ?? []
  return <section className={css.source}><div className={css.detailHead}><h2>{t('raw')}</h2><Button variant="ghost" size="sm" onClick={close}>{t('close')}</Button></div>
    <p className={css.muted}>{t('retained')}</p><Input aria-label={t('rawSearch')} placeholder={t('rawSearch')} value={search} onChange={(event) => { setSearch(event.target.value) }} />
    <p className={css.muted}>{t('pageSearch')}</p><Notice state={raw} t={t} />
    {page && records.length === 0 && <p>{t('noRaw')}</p>}{records.map(record => <RawRecord key={record.id} record={record} t={t} />)}
    {page && <Pager after={after} next={page.nextCursor} more={page.hasMore} change={setAfter} t={t} />}
  </section>
}
function RawRecord({ record, t }: { record: CollectedRecord; t: Translate }): ReactNode {
  return <details><summary className={css.mono}>{record.sequence} · {record.type} · {t('sourceCursor', { cursor: record.cursor })}</summary><pre className={css.raw}>{record.content}</pre></details>
}
/**
 * Render the standard product tree glyph; the sidebar owns its button and label.
 * @param props - sidebar icon geometry.
 * @returns shared icon.
 */
export function TrajectoryIcon({ size }: Pick<PropsRuntime<'sidebar.panellist'>, 'size'>): ReactNode { return <IconWorkspaceTreeOutlineRegular size={size} /> }
