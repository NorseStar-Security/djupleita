/** Durable collector-derived trace projection with lifecycle-owned incremental indexing. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, lstatSync, mkdirSync, openSync, statfsSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CollectedRecord, CollectorIdentity } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import { CollectorError } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type { CompletedSpanPage, CompletedSpanQuery, CompletedTraceSpan, ProjectionErrorCode, ProjectionId, ProjectionStatus, SpanId, TraceDetailPage, TraceDetailQuery, TraceId, TraceListPage, TraceListQuery, TraceSpan, TraceStatus, TraceSummary } from './types.ts'

declare module '@deepseek-ai/cordis' { interface Context { trajectoryProjection: TrajectoryProjection } }

/** Stable failure identity; diagnostics exclude source record content. */
export class ProjectionError extends Error {
  constructor(readonly code: ProjectionErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'ProjectionError'
  }
}

/** Read-only bounded trace views; query calls never scan or recompute the source collector. */
export abstract class TrajectoryProjection extends Service {
  constructor(ctx: Context) { super(ctx, 'trajectoryProjection') }
  /** Read exact-filtered traces through immutable keyset identities.
   * @param query - direction, exclusive cursor, filters, and bounded item count.
   * @returns complete trace page within the configured serialized-byte budget.
   */
  abstract list(query: TraceListQuery): Promise<TraceListPage>
  /** Read a trace's oldest-first persisted spans without loading its original event history.
   * @param query - trace identity, exclusive span ordinal, and bounded item count.
   * @returns explicit missing trace or complete bounded span page.
   */
  abstract detail(query: TraceDetailQuery): Promise<TraceDetailPage>
  /** Read durable indexing progress and visible terminal failure.
   * @returns generation identity, state, counters, and collector progress.
   */
  abstract status(): Promise<ProjectionStatus>
  /** Read immutable completed spans for an independently checkpointed remote trace exporter.
   * @param query - exclusive completion ordinal and complete-page item/byte bounds.
   * @returns stable completed spans and projection generation identity.
   */
  abstract readCompleted(query: CompletedSpanQuery): Promise<CompletedSpanPage>
}

/** Dedicated local storage, incremental intake bounds, and complete query-page budgets. */
export interface Config {
  /** Absolute private SQLite path; do not reuse the collector database. */
  path: string
  /** Delay between bounded collector polls. */
  pollIntervalMs: number
  /** Maximum source records committed by one poll. */
  recordsPerPoll: number
  /** Complete collector-page byte budget; must fit at least one source record. */
  sourcePageBytes: number
  /** Maximum trace or span count requested by one query. */
  maxQueryItems: number
  /** Maximum complete serialized query-page bytes. */
  maxQueryBytes: number
  /** Maximum complete persisted span metadata bytes. */
  maxSpanBytes: number
  /** Maximum retained trace identities. */
  maxTraces: number
  /** Maximum retained span identities, including completed export rows. */
  maxSpans: number
  /** Maximum simultaneously open spans in one trace; bounds turn-settlement work. */
  maxOpenSpansPerTrace: number
  /** Maximum database plus WAL/shared-memory bytes with conservative write reservations. */
  maxDatabaseBytes: number
  /** Filesystem free bytes preserved beyond write reservations. */
  minFreeBytes: number
}

interface State extends Record<string, SQLOutputValue> {
  projection_id: string
  cursor: number
  anchor_id: string | null
  anchor_sha: string | null
  error_code: ProjectionErrorCode | null
  completed: number
}
interface SessionState {
  identity: CollectorIdentity
  sessionId: SessionId
  parentSessionId: SessionId | null
  currentTurn: number | null
  inheritedEventCount: number
}
interface JsonRow extends Record<string, SQLOutputValue> { data: string }
const count = () => z.natural().min(1).max(Number.MAX_SAFE_INTEGER)
const appId = 0x44534850
const schemaVersion = 1

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function source(message: string): never { throw new ProjectionError('PROJECTION_SOURCE', message) }
function quota(): never { throw new ProjectionError('PROJECTION_QUOTA', 'Projection capacity exhausted; preserve both archives and ask the instructor to expand storage before reload.') }
function id(value: unknown, length: number): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, length) }
function field(value: unknown): string { if (typeof value !== 'string' || !value) source('A known event is missing a required identifier; indexing stopped before that record.'); return value }
function integer(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) source('A known event has an invalid turn or step; indexing stopped before that record.'); return value }
function parse(value: string): Record<string, unknown> {
  let result: unknown
  try { result = JSON.parse(value) } catch { source('Collector JSON could not be decoded; indexing stopped before that record.') }
  if (!object(result)) source('Collector content is not an object; indexing stopped before that record.')
  return result
}

function privateEntry(path: string, directory: boolean): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid?.()))) {
    throw new ProjectionError('PROJECTION_STORAGE', 'Projection paths must be owner-only real files and directories; correct permissions before loading.')
  }
}

function open(config: Config): DatabaseSync {
  mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 })
  privateEntry(dirname(config.path), true)
  try { closeSync(openSync(config.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  privateEntry(config.path, false)
  const db = new DatabaseSync(config.path)
  try {
    const app = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name)
    if (!((app.application_id === 0 && version.user_version === 0 && !names.length) || (app.application_id === appId && version.user_version === schemaVersion && JSON.stringify(names) === JSON.stringify(['child_links', 'projection_state', 'sessions', 'spans', 'traces'])))) {
      throw new ProjectionError('PROJECTION_STORAGE', 'Projection database is foreign or unsupported; preserve it and choose the correct read-model archive.')
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA wal_autocheckpoint=128; PRAGMA journal_size_limit=0;')
    const page = db.prepare('PRAGMA page_size').get() as { page_size: number }
    db.exec(`PRAGMA max_page_count=${Math.floor(config.maxDatabaseBytes / page.page_size)}; BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS projection_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), projection_id TEXT NOT NULL, cursor INTEGER NOT NULL, anchor_id TEXT, anchor_sha TEXT, error_code TEXT, completed INTEGER NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (installation TEXT NOT NULL, session TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(installation,session)) STRICT;
      CREATE TABLE IF NOT EXISTS traces (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, installation TEXT NOT NULL, student TEXT NOT NULL, cohort TEXT NOT NULL, session TEXT NOT NULL, parent_session TEXT, status TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS spans (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, trace TEXT NOT NULL REFERENCES traces(id), completed INTEGER UNIQUE, data TEXT NOT NULL) STRICT;
      CREATE INDEX IF NOT EXISTS spans_trace ON spans(trace,ordinal);
      CREATE TABLE IF NOT EXISTS child_links (installation TEXT NOT NULL, child TEXT NOT NULL, trace TEXT NOT NULL, PRIMARY KEY(installation,child)) STRICT;
      PRAGMA application_id=${appId}; PRAGMA user_version=${schemaVersion}; COMMIT;`)
    db.prepare('INSERT OR IGNORE INTO projection_state VALUES(1,?,0,NULL,NULL,NULL,0)').run(randomUUID())
    return db
  } catch (error) { db.close(); throw error }
}

/** SQLite projection provider; original source records and log-export ACKs remain untouched. */
export default class SqliteTrajectoryProjection extends TrajectoryProjection {
  static inject = ['trajectoryCollector']
  static Config: z<Partial<Config>, Config> = z.object({
    path: z.transform(z.string().required(), (value) => { if (!isAbsolute(value)) throw new Error('projection path must be absolute'); return value }),
    pollIntervalMs: count().max(2_147_483_647).default(500), recordsPerPoll: count().max(10_000).default(128),
    sourcePageBytes: count().default(4 * 1024 * 1024), maxQueryItems: count().max(10_000).default(128),
    maxQueryBytes: count().default(4 * 1024 * 1024), maxSpanBytes: count().default(1024 * 1024),
    maxTraces: count().default(100_000), maxSpans: count().default(1_000_000),
    maxOpenSpansPerTrace: count().default(1024),
    maxDatabaseBytes: count().min(65536).default(1024 * 1024 * 1024),
    minFreeBytes: z.natural().max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024),
  })

  private readonly db: DatabaseSync
  private readonly lifetime = new AbortController()
  private phase: ProjectionStatus['state'] = 'indexing'
  private sourceCursor = 0
  private closed = false
  private terminalCode: ProjectionErrorCode | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    try { this.db = open(config) }
    catch (error) { throw error instanceof ProjectionError ? error : new ProjectionError('PROJECTION_STORAGE', 'Projection storage could not open; preserve it and restore private local storage.', { cause: error }) }
    const worker = this.index()
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await worker
      this.phase = 'stopped'
      this.closed = true
      this.db.close()
    })
  }

  private state(): State { return this.db.prepare('SELECT * FROM projection_state WHERE singleton=1').get() as State }
  private rows(table: 'traces' | 'spans'): number { return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count }
  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { operation(); this.db.exec('COMMIT') }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  private available(): void { if (this.closed) throw new ProjectionError('PROJECTION_UNAVAILABLE', 'Projection is closed; reload its configured archive before querying.') }
  private cancelled(): boolean { return this.lifetime.signal.aborted }
  private capacity(reservation: number): void {
    const fs = statfsSync(dirname(this.config.path))
    const reserve = reservation * 8 + 65536
    if (fs.bavail * fs.bsize < this.config.minFreeBytes + reserve) quota()
    let bytes = statSync(this.config.path).size
    for (const suffix of ['-wal', '-shm']) {
      try { bytes += statSync(this.config.path + suffix).size }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (bytes + reserve > this.config.maxDatabaseBytes) quota()
  }
  private failure(error: unknown): void {
    const failure = error instanceof ProjectionError ? error : new ProjectionError('PROJECTION_STORAGE', 'Projection storage failed; preserve both archives and restore storage before reload.', { cause: error })
    this.phase = 'failed'
    this.terminalCode = failure.code
    this.lifetime.abort()
    try { this.db.prepare('UPDATE projection_state SET error_code=? WHERE singleton=1').run(failure.code) }
    catch (storageError) { this.ctx.logger.error('Projection failure status could not be persisted; preserve the database and inspect storage before reload.', storageError) }
    this.ctx.logger.error(`Trajectory projection stopped (${failure.code}); the affected collector cursor was not acknowledged. Preserve both archives and ask the instructor to repair the source or capacity before a reviewed rebuild.`)
  }
  private async index(): Promise<void> {
    try {
      const initial = this.state()
      if (initial.error_code !== null) { this.phase = 'failed'; return }
      if (initial.cursor) {
        const anchor = await this.ctx.trajectoryCollector.read({
          after: initial.cursor - 1, limit: 1, maxBytes: this.config.sourcePageBytes,
        })
        if (this.cancelled()) return
        const record = anchor.records[0]
        if (record?.cursor !== initial.cursor || record.id !== initial.anchor_id || record.sha256 !== initial.anchor_sha) source('Collector anchor changed or was pruned; indexing stopped without resetting progress.')
      }
      for (;;) {
        this.sourceCursor = (await this.ctx.trajectoryCollector.status()).lastCursor
        if (this.cancelled()) return
        const state = this.state()
        if (this.sourceCursor < state.cursor) source('Collector cursor moved backward; indexing stopped without resetting progress.')
        const page = await this.ctx.trajectoryCollector.read({
          after: state.cursor, limit: this.config.recordsPerPoll, maxBytes: this.config.sourcePageBytes,
        })
        if (this.cancelled()) return
        if (!page.records.length && this.sourceCursor > state.cursor) source('Collector has a missing or pruned unprojected prefix; indexing stopped.')
        this.phase = page.records.length ? 'indexing' : 'idle'
        for (const record of page.records) {
          if (record.cursor !== this.state().cursor + 1) source('Collector records are not contiguous; indexing stopped before the gap.')
          this.transaction(() => {
            this.capacity(Buffer.byteLength(record.content) + 4096)
            this.fold(record)
            this.db.prepare('UPDATE projection_state SET cursor=?,anchor_id=?,anchor_sha=? WHERE singleton=1').run(record.cursor, record.id, record.sha256)
          })
        }
        await delay(this.config.pollIntervalMs, undefined, { signal: this.lifetime.signal })
      }
    } catch (error) {
      if (!this.lifetime.signal.aborted) this.failure(error instanceof CollectorError
        ? new ProjectionError('PROJECTION_SOURCE', 'Collector reads failed; indexing stopped without advancing the affected record.', { cause: error }) : error)
    }
  }

  private session(record: CollectedRecord): SessionState | undefined {
    const row = this.db.prepare('SELECT data FROM sessions WHERE installation=? AND session=?').get(record.identity.installationId, record.sessionId) as JsonRow | undefined
    return row ? JSON.parse(row.data) as SessionState : undefined
  }
  private saveSession(session: SessionState): void {
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?) ON CONFLICT(installation,session) DO UPDATE SET data=excluded.data').run(session.identity.installationId, session.sessionId, JSON.stringify(session))
  }
  private trace(row: JsonRow): TraceSummary {
    const trace = JSON.parse(row.data) as TraceSummary
    return { ...trace, parentTraceId: this.parent(trace.identity.installationId, trace.sessionId, trace.parentSessionId) }
  }
  private parent(installation: string, session: SessionId, parentSession: SessionId | null): TraceId | null {
    const parent = this.db.prepare('SELECT c.trace FROM child_links c JOIN traces t ON t.id=c.trace WHERE c.installation=? AND c.child=? AND t.session=?').get(installation, session, parentSession) as { trace: string } | undefined
    return parent ? brandString<TraceId>(parent.trace) : null
  }
  private saveTrace(trace: TraceSummary): void {
    this.db.prepare('INSERT INTO traces VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,name=excluded.name,data=excluded.data').run(trace.traceId, trace.cursor, trace.identity.installationId, trace.identity.studentId, trace.identity.cohortId, trace.sessionId, trace.parentSessionId, trace.status, trace.name, JSON.stringify(trace))
  }
  private root(session: SessionState, turn: number | null, record: CollectedRecord): TraceSummary {
    const traceId = brandString<TraceId>(id([record.identity.installationId, record.sessionId, turn], 32))
    const prior = this.db.prepare('SELECT data FROM traces WHERE id=?').get(traceId) as JsonRow | undefined
    if (prior) return this.trace(prior)
    if (this.rows('traces') >= this.config.maxTraces) quota()
    const trace: TraceSummary = {
      traceId, rootSpanId: brandString<SpanId>(id([traceId, 'turn', 'root'], 16)), cursor: record.cursor,
      identity: record.identity, sessionId: record.sessionId, turn, name: turn === null ? 'Session activity' : `Turn ${turn}`,
      startTime: record.timestamp, endTime: null, status: 'running', parentSessionId: session.parentSessionId,
      parentTraceId: this.parent(record.identity.installationId, record.sessionId, session.parentSessionId),
      firstCursor: record.cursor, lastCursor: record.cursor,
    }
    this.saveTrace(trace)
    this.span(trace, record, 'turn', 'root', trace.name, { inherited: record.sequence < session.inheritedEventCount })
    return trace
  }
  private span(trace: TraceSummary, record: CollectedRecord, kind: TraceSpan['kind'], key: string, name: string, attributes: Record<string, JsonValue>): TraceSpan {
    const spanId = brandString<SpanId>(id([trace.traceId, kind, key], 16))
    const prior = this.db.prepare('SELECT data FROM spans WHERE id=?').get(spanId) as JsonRow | undefined
    if (prior) source('A span identity was reused by another source event; indexing stopped before changing the original span.')
    if (this.rows('spans') >= this.config.maxSpans) quota()
    const pending = this.db.prepare('SELECT COUNT(*) AS count FROM spans WHERE trace=? AND completed IS NULL').get(trace.traceId) as { count: number }
    if (pending.count >= this.config.maxOpenSpansPerTrace) quota()
    const cursor = (this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS ordinal FROM spans').get() as { ordinal: number }).ordinal
    const value: TraceSpan = {
      traceId: trace.traceId, spanId, parentSpanId: kind === 'turn' ? null : trace.rootSpanId,
      cursor, completionCursor: null, identity: trace.identity, sessionId: trace.sessionId, turn: trace.turn,
      parentSessionId: trace.parentSessionId, parentTraceId: trace.parentTraceId, kind, name,
      startTime: record.timestamp, endTime: null, status: 'running',
      firstCursor: record.cursor, lastCursor: record.cursor, firstRecordId: record.id, lastRecordId: record.id, attributes,
    }
    this.saveSpan(value)
    return value
  }
  private saveSpan(span: TraceSpan): void {
    const data = JSON.stringify(span)
    if (Buffer.byteLength(data) > this.config.maxSpanBytes) quota()
    this.db.prepare('INSERT INTO spans VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET completed=excluded.completed,data=excluded.data').run(span.spanId, span.cursor, span.traceId, span.completionCursor, data)
  }
  private close(span: TraceSpan, record: CollectedRecord, status: TraceStatus, attributes: Record<string, JsonValue> = {}): void {
    if (span.completionCursor !== null) source('A completed span received another settlement; indexing stopped before modifying its immutable export row.')
    const completion = this.state().completed + 1
    if (!Number.isSafeInteger(completion)) quota()
    this.saveSpan({ ...span, completionCursor: completion, endTime: Math.max(span.startTime, record.timestamp), status,
      lastCursor: record.cursor, lastRecordId: record.id, attributes: { ...span.attributes, ...attributes,
        ...record.timestamp < span.startTime ? { clockRegressed: true, recordedEndTime: record.timestamp } : {} } })
    this.db.prepare('UPDATE projection_state SET completed=? WHERE singleton=1').run(completion)
  }
  private fold(record: CollectedRecord): void {
    const value = parse(record.content)
    if (record.sequence === -1) {
      if (!object(value.header) || value.header.id !== record.sessionId || !Number.isSafeInteger(value.inheritedEventCount) || Number(value.inheritedEventCount) < 0) source('Session header metadata is invalid; indexing stopped.')
      if (value.header.parentSession !== undefined && typeof value.header.parentSession !== 'string') source('Session parent identity is invalid; indexing stopped.')
      this.saveSession({ identity: record.identity, sessionId: record.sessionId,
        parentSessionId: value.header.parentSession === undefined ? null : brandString<SessionId>(value.header.parentSession),
        currentTurn: null, inheritedEventCount: Number(value.inheritedEventCount) })
      return
    }
    if (value.seq !== record.sequence || value.type !== record.type || value.time !== record.timestamp) source('Event envelope is invalid; indexing stopped before that record.')
    const session = this.session(record)
    if (!session) source('Session events arrived without their header; indexing stopped.')
    const data = object(value.data) ? value.data : {}
    const turn = ['turn/start', 'turn/end', 'step/start', 'step/end', 'tool/call', 'tool/result', 'assistant/message', 'assistant/attempt'].includes(record.type)
      ? integer(data.turn) : session.currentTurn
    const trace = this.root(session, turn, record)
    trace.lastCursor = record.cursor
    if (record.type === 'turn/start') { session.currentTurn = integer(data.turn); this.saveSession(session) }
    if (record.type === 'subagent/catalog') {
      const child = field(data.childId)
      this.db.prepare('INSERT INTO child_links VALUES(?,?,?) ON CONFLICT(installation,child) DO NOTHING').run(record.identity.installationId, child, trace.traceId)
    }
    if (record.type === 'subagent/descriptor' && typeof data.label === 'string') trace.name = `${data.label} · ${trace.name}`
    if (record.type === 'tool/call') {
      this.span(trace, record, 'tool', field(data.callId), field(data.name), { callId: field(data.callId), tool: field(data.name) })
    } else if (record.type === 'tool/result') {
      if (!object(data.message)) source('Tool settlement is missing its message; indexing stopped.')
      const callId = field(data.message.toolCallId)
      const row = this.db.prepare('SELECT data FROM spans WHERE id=?').get(id([trace.traceId, 'tool', callId], 16)) as JsonRow | undefined
      if (!row) source('Tool settlement has no preceding call; indexing stopped.')
      const span = JSON.parse(row.data) as TraceSpan
      const status = span.attributes.scopeAllowed === false ? 'blocked' : data.message.isError === true ? 'error' : 'completed'
      this.close(span, record, status, object(data.error) && typeof data.error.code === 'string' ? { errorCode: data.error.code } : {})
      if (status !== 'completed') trace.status = status
    } else if (record.type === 'assistant/message' || record.type === 'assistant/attempt') {
      const step = integer(data.step)
      const model = this.span(trace, record, 'model', String(record.sequence), `Model step ${step}`, { step, eventType: record.type })
      if (!Array.isArray(data.stream)) source('Model settlement is missing its timed stream; indexing stopped.')
      let earliest: number | undefined
      let failed = record.type === 'assistant/attempt' || data.interrupted === true
      for (const entry of data.stream) {
        if (!object(entry)) source('Model stream timing is invalid; indexing stopped.')
        const time = entry.type === 'chunk' ? entry.time : entry.time0
        if (typeof time !== 'number' || !Number.isSafeInteger(time) || time < 0) source('Model stream timing is invalid; indexing stopped.')
        earliest = earliest === undefined ? time : Math.min(earliest, time)
        if (object(entry.chunk) && entry.chunk.type === 'finish' && object(entry.chunk.reason) && ['error', 'aborted'].includes(String(entry.chunk.reason.kind))) failed = true
      }
      model.startTime = earliest ?? record.timestamp
      model.attributes.timingSource = data.stream.length ? 'persisted-stream-first-record' : 'settlement-only'
      this.close(model, record, failed ? 'error' : 'completed')
      if (failed) trace.status = 'error'
    } else if (record.type.startsWith('plugin:network-scope-guard/')) {
      const scope = this.span(trace, record, 'scope', String(record.sequence), record.type.slice('plugin:network-scope-guard/'.length), { eventType: record.type })
      let status: TraceStatus = 'completed'
      if (record.type === 'plugin:network-scope-guard/judge') {
        if (typeof data.allowed !== 'boolean' || typeof data.code !== 'string') source('Scope decision metadata is invalid; indexing stopped.')
        scope.attributes = {
          ...scope.attributes, allowed: data.allowed, code: data.code, callId: field(data.callId), tool: field(data.tool),
          attribution: 'pending-tool-call',
        }
        status = data.allowed ? 'completed' : 'blocked'
        const row = this.db.prepare('SELECT data FROM spans WHERE id=?').get(id([trace.traceId, 'tool', data.callId], 16)) as JsonRow | undefined
        if (row) {
          const tool = JSON.parse(row.data) as TraceSpan
          if (tool.completionCursor === null) {
            tool.attributes.scopeAllowed = data.allowed; tool.attributes.scopeCode = data.code; this.saveSpan(tool)
          }
        }
      } else if (record.type === 'plugin:network-scope-guard/unavailable') {
        status = 'error'; scope.attributes.code = field(data.code)
      } else scope.attributes.attribution = 'shared-environment'
      this.close(scope, record, status)
      if (status !== 'completed') trace.status = status
    } else if (record.type === 'turn/end') {
      if (!object(data.reason)) source('Turn settlement is missing its reason; indexing stopped.')
      const reason = field(data.reason.kind)
      const status: TraceStatus = reason === 'error' ? 'error' : reason === 'blocked' ? 'blocked'
        : reason === 'completed' ? trace.status === 'running' ? 'completed' : trace.status : 'incomplete'
      const reservation = this.db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(length(data)),0) AS bytes FROM spans WHERE trace=? AND completed IS NULL').get(trace.traceId) as { count: number; bytes: number }
      this.capacity(reservation.bytes + reservation.count * 4096)
      const pending = this.db.prepare('SELECT data FROM spans WHERE trace=? AND completed IS NULL ORDER BY ordinal').all(trace.traceId) as JsonRow[]
      for (const row of pending) {
        const span = JSON.parse(row.data) as TraceSpan
        this.close(span, record, span.kind === 'turn' ? status : 'incomplete', { endReason: reason })
      }
      trace.status = status; trace.endTime = Math.max(trace.startTime, record.timestamp)
      session.currentTurn = null; this.saveSession(session)
    } else {
      // Merge-extensible event kinds remain visible as recorded points; unknown kinds do not imply model/tool semantics.
      const point = this.span(trace, record, 'event', String(record.sequence), record.type, { eventType: record.type })
      this.close(point, record, 'completed')
    }
    this.saveTrace(trace)
  }

  private bounds(after: number, limit: number): void {
    this.available()
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > this.config.maxQueryItems) throw new ProjectionError('PROJECTION_INPUT', 'Use a nonnegative exclusive cursor and a positive bounded query item count.')
  }
  private bounded<T>(value: T, maxBytes = this.config.maxQueryBytes): T {
    if (Buffer.byteLength(JSON.stringify(value)) > maxBytes) throw new ProjectionError('PROJECTION_QUOTA', 'The complete projection page exceeds its byte budget; request fewer items or raise the reviewed query budget.')
    return value
  }
  private query<T>(operation: () => T): Promise<T> {
    return new Promise((resolve) => {
      try { resolve(operation()) }
      catch (error) {
        if (error instanceof ProjectionError) throw error
        this.failure(error)
        throw new ProjectionError('PROJECTION_STORAGE', 'Projection read failed; preserve the read model and restore storage before reload.', { cause: error })
      }
    })
  }
  override list(query: TraceListQuery): Promise<TraceListPage> {
    return this.query(() => {
      this.bounds(query.after, query.limit)
      if (!['newest', 'oldest'].includes(query.direction)) throw new ProjectionError('PROJECTION_INPUT', 'Select newest or oldest trace pagination.')
      const filters: string[] = []
      const params: (string | number)[] = []
      if (query.after) { filters.push(`ordinal${query.direction === 'newest' ? '<' : '>'}?`); params.push(query.after) }
      for (const [column, value] of [['installation', query.filters?.installationId], ['student', query.filters?.studentId], ['cohort', query.filters?.cohortId], ['session', query.filters?.sessionId], ['parent_session', query.filters?.parentSessionId], ['status', query.filters?.status]] as const) {
        if (value !== undefined) { filters.push(`${column}=?`); params.push(value) }
      }
      if (query.filters?.search !== undefined) {
        if (Buffer.byteLength(query.filters.search) > 256) throw new ProjectionError('PROJECTION_INPUT', 'Trace search must be at most 256 UTF-8 bytes.')
        filters.push("instr(lower(name||' '||installation||' '||session),lower(?))>0"); params.push(query.filters.search)
      }
      const rows = this.db.prepare(`SELECT data FROM traces ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY ordinal ${query.direction === 'newest' ? 'DESC' : 'ASC'} LIMIT ?`).all(...params, query.limit + 1) as JsonRow[]
      const traces = rows.slice(0, query.limit).map(row => this.trace(row))
      return this.bounded({ traces, nextCursor: traces.at(-1)?.cursor ?? query.after, hasMore: rows.length > query.limit })
    })
  }
  override detail(query: TraceDetailQuery): Promise<TraceDetailPage> {
    return this.query(() => {
      this.bounds(query.after, query.limit)
      const row = this.db.prepare('SELECT data FROM traces WHERE id=?').get(query.traceId) as JsonRow | undefined
      const rows = this.db.prepare('SELECT data FROM spans WHERE trace=? AND ordinal>? ORDER BY ordinal LIMIT ?').all(query.traceId, query.after, query.limit + 1) as JsonRow[]
      const spans = rows.slice(0, query.limit).map(value => JSON.parse(value.data) as TraceSpan)
      return this.bounded({ trace: row ? this.trace(row) : undefined, spans,
        nextCursor: spans.at(-1)?.cursor ?? query.after, hasMore: rows.length > query.limit })
    })
  }
  override status(): Promise<ProjectionStatus> {
    return this.query(() => {
      this.available()
      const state = this.state()
      const code = state.error_code ?? this.terminalCode
      return { projectionId: brandString<ProjectionId>(state.projection_id), state: code === undefined ? this.phase : 'failed',
        collectorCursor: state.cursor, sourceCursor: this.sourceCursor, traces: this.rows('traces'), spans: this.rows('spans'),
        completedCursor: state.completed,
        ...code === undefined ? {} : { errorCode: code } }
    })
  }
  override readCompleted(query: CompletedSpanQuery): Promise<CompletedSpanPage> {
    return this.query(() => {
      this.bounds(query.after, query.limit)
      if (!Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1 || query.maxBytes > this.config.maxQueryBytes) throw new ProjectionError('PROJECTION_INPUT', 'Use a positive completed-span page byte budget within the configured maximum.')
      const rows = this.db.prepare('SELECT data FROM spans WHERE completed>? ORDER BY completed LIMIT ?').all(query.after, query.limit + 1) as JsonRow[]
      const spans = rows.slice(0, query.limit).map((value) => {
        const span = JSON.parse(value.data) as TraceSpan
        if (span.completionCursor === null || span.endTime === null) throw new Error('Stored completed span has invalid settlement metadata.')
        return span as CompletedTraceSpan
      })
      return this.bounded({ projectionId: brandString<ProjectionId>(this.state().projection_id), spans,
        nextCursor: spans.at(-1)?.completionCursor ?? query.after, hasMore: rows.length > query.limit }, query.maxBytes)
    })
  }
}
