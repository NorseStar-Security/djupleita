/**
 * Per-seat commit logic for trajectory records: validate, deduplicate, verify digests, store the
 * exact bytes, advance the per-Session receipt chain, and index the result.
 *
 * Callers must serialize calls for one seat; the seat Durable Object owns that queue. Storage
 * failures propagate unchanged so the receiver can answer with a retryable status.
 */
import type { OtlpLogRecord } from './otlp.ts'
import { summarize, type ActivitySummary } from './activity.ts'

/** A SQLite binding or result value. */
export type SqlValue = string | number | null

/** Storage the ledger needs from its host. */
export interface LedgerStore {
  /**
   * Run one SQL statement.
   * @param query - A single statement with `?` placeholders.
   * @param params - Placeholder values.
   * @returns Result rows; an empty array for statements without results.
   */
  sql(query: string, ...params: SqlValue[]): Record<string, SqlValue>[]
  /**
   * Run `body` atomically.
   * @param body - Synchronous statements to apply together.
   * @returns The value `body` returns.
   */
  transaction<T>(body: () => T): T
  /**
   * Store immutable bytes; an existing object with the same `sha256` and `part` metadata is a no-op.
   * @param key - Object key.
   * @param bytes - Exact bytes.
   * @param metadata - Custom metadata, including `sha256` and `part`.
   * @returns Completion after the object is durable; rejects when a different object holds the key.
   */
  putObject(key: string, bytes: Uint8Array, metadata: Record<string, string>): Promise<void>
  /**
   * Read stored bytes.
   * @param key - Object key.
   * @returns The bytes, or `null` when absent.
   */
  getObject(key: string): Promise<Uint8Array | null>
}

/** Trusted seat identity from a verified seat token. */
export interface SeatIdentity {
  cohort: string
  student: string
  installation: string
}

/** One committed, complete record as the live board receives it. */
export interface Activity extends ActivitySummary, SeatIdentity {
  sessionId: string
  seq: number
  type: string
  eventMs: number | null
  receivedMs: number
  recordSha256: string
}

/** Result of one commit call. */
export interface CommitResult {
  accepted: number
  duplicates: number
  activities: Activity[]
}

/** A record or request the receiver must refuse without retry. */
export class RecordRejected extends Error {
  override readonly name = 'RecordRejected'
  readonly code: string
  readonly status: number

  constructor(code: string, status: number, message: string) {
    super(message)
    this.code = code
    this.status = status
  }
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS seat (id INTEGER PRIMARY KEY CHECK (id = 1), cohort TEXT NOT NULL, student TEXT NOT NULL,
    installation TEXT NOT NULL, revoked_ms INTEGER, revoked_reason TEXT)`,
  `CREATE TABLE IF NOT EXISTS parts (record_id TEXT NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL,
    session_id TEXT NOT NULL, seq INTEGER NOT NULL, object_key TEXT NOT NULL, bytes INTEGER NOT NULL,
    received_ms INTEGER NOT NULL, PRIMARY KEY (record_id, part))`,
  `CREATE TABLE IF NOT EXISTS records (record_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
    event_type TEXT NOT NULL, record_sha256 TEXT NOT NULL, parts INTEGER NOT NULL, bytes INTEGER NOT NULL,
    event_ms INTEGER, received_ms INTEGER NOT NULL, chain TEXT NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS records_by_session ON records (session_id, seq)',
  `CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, first_ms INTEGER NOT NULL, last_ms INTEGER NOT NULL,
    chain TEXT NOT NULL, chain_seq INTEGER NOT NULL, records INTEGER NOT NULL, reasoning_chars INTEGER NOT NULL,
    tool_calls INTEGER NOT NULL, tool_errors INTEGER NOT NULL, scope_denials INTEGER NOT NULL, title TEXT, model TEXT)`,
  `CREATE TABLE IF NOT EXISTS problems (at_ms INTEGER NOT NULL, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
    code TEXT NOT NULL, detail TEXT NOT NULL)`,
]

const encoder = new TextEncoder()
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })
const HEX64 = /^[0-9a-f]{64}$/

/**
 * Create the seat tables when absent.
 * @param store - The seat's storage.
 */
export function migrate(store: LedgerStore): void {
  for (const statement of SCHEMA) store.sql(statement)
}

/**
 * Hex SHA-256 of bytes or UTF-8 text.
 * @param value - Bytes or text.
 * @returns Lowercase hexadecimal digest.
 */
export async function sha256Hex(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>))
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * First link of a Session's receipt chain.
 * @param installation - Seat installation label.
 * @param sessionId - DSH Session id.
 * @returns The genesis digest.
 */
export function genesis(installation: string, sessionId: string): Promise<string> {
  return sha256Hex(`ns-audit/v1\n${installation}\n${sessionId}`)
}

/**
 * Next link of a Session's receipt chain, over receipt order, sequence, and record digest.
 * @param previous - The previous link.
 * @param seq - The record's `dsh.event.seq`.
 * @param recordSha256 - The record's verified digest.
 * @returns The next link.
 */
export function nextLink(previous: string, seq: number, recordSha256: string): Promise<string> {
  return sha256Hex(`${previous}\n${seq}\n${recordSha256}`)
}

interface RecordMeta {
  sessionId: string
  seq: number
  type: string
  recordId: string
  sha256: string
  part: number
  parts: number
  eventMs: number | null
}

function attribute(record: OtlpLogRecord, key: string): string | number | boolean | null {
  return record.attributes[key] ?? null
}

function reject(code: string, message: string, status = 400): never {
  throw new RecordRejected(code, status, message)
}

function readMeta(record: OtlpLogRecord, identity: SeatIdentity): RecordMeta {
  if (attribute(record, 'dsh.trajectory.schema') !== 1) reject('UNSUPPORTED_SCHEMA', 'dsh.trajectory.schema must be 1')
  if (attribute(record, 'dsh.source.id') !== identity.installation) {
    reject('SOURCE_MISMATCH', 'dsh.source.id must equal the seat token installation', 403)
  }
  const sessionId = attribute(record, 'dsh.session.id')
  const seq = attribute(record, 'dsh.event.seq')
  const type = attribute(record, 'dsh.event.type')
  const recordId = attribute(record, 'dsh.record.id')
  const sha256 = attribute(record, 'dsh.record.sha256')
  const encoding = attribute(record, 'dsh.record.encoding')
  const part = attribute(record, 'dsh.record.part')
  const parts = attribute(record, 'dsh.record.parts')
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 256) reject('BAD_SESSION', 'dsh.session.id is missing or invalid')
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < -1) reject('BAD_SEQUENCE', 'dsh.event.seq must be an integer of at least -1')
  if (typeof type !== 'string' || type.length === 0 || type.length > 256) reject('BAD_TYPE', 'dsh.event.type is missing or invalid')
  if (typeof recordId !== 'string' || !HEX64.test(recordId)) reject('BAD_RECORD_ID', 'dsh.record.id must be 64 lowercase hex characters')
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) reject('BAD_DIGEST', 'dsh.record.sha256 must be 64 lowercase hex characters')
  if (typeof parts !== 'number' || !Number.isSafeInteger(parts) || parts < 1 || parts > 4096) reject('BAD_PARTS', 'dsh.record.parts must be 1 to 4096')
  if (typeof part !== 'number' || !Number.isSafeInteger(part) || part < 0 || part >= parts) reject('BAD_PART', 'dsh.record.part must be below dsh.record.parts')
  if (encoding !== (parts === 1 ? 'json' : 'base64-json-utf8')) reject('BAD_ENCODING', 'dsh.record.encoding does not match dsh.record.parts')
  if (typeof record.body !== 'string') reject('BAD_BODY', 'the log record body must be a string')
  const nanos = record.timeUnixNano === undefined ? null : Number(BigInt(record.timeUnixNano) / 1_000_000n)
  return { sessionId, seq, type, recordId, sha256, part, parts, eventMs: nanos }
}

function decodeBase64(text: string): Uint8Array {
  if (text.length === 0 || text.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) reject('BAD_FRAGMENT', 'fragment body is not canonical base64')
  return Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length }
  return out
}

/**
 * Object key for one stored part; sortable by Session, sequence, and part.
 * @param identity - Trusted seat identity.
 * @param sessionId - DSH Session id.
 * @param seq - Event sequence (`-1` for the header).
 * @param part - Fragment index.
 * @param parts - Fragment count.
 * @param recordId - Stable record id.
 * @returns The R2 key.
 */
export function objectKey(identity: SeatIdentity, sessionId: string, seq: number, part: number, parts: number, recordId: string): string {
  const position = String(seq + 1).padStart(10, '0')
  return `raw/${identity.cohort}/${identity.student}/${identity.installation}/${encodeURIComponent(sessionId)}/${position}-p${part}of${parts}-${recordId.slice(0, 16)}`
}

function bindSeat(store: LedgerStore, identity: SeatIdentity): void {
  const rows = store.sql('SELECT cohort, student, installation, revoked_ms FROM seat WHERE id = 1')
  const seat = rows[0]
  if (seat === undefined) {
    store.sql('INSERT INTO seat (id, cohort, student, installation) VALUES (1, ?, ?, ?)', identity.cohort, identity.student, identity.installation)
    return
  }
  if (seat['revoked_ms'] !== null) reject('SEAT_REVOKED', 'this seat is revoked', 403)
  if (seat['cohort'] !== identity.cohort || seat['student'] !== identity.student || seat['installation'] !== identity.installation) {
    reject('IDENTITY_CONFLICT', 'this installation is bound to a different cohort or student', 409)
  }
}

/**
 * Commit decoded log records for one seat.
 * @param store - The seat's storage; the caller serializes calls.
 * @param identity - Trusted identity from the seat token.
 * @param records - Decoded OTLP log records from one request.
 * @param nowMs - Receipt time in milliseconds.
 * @returns Accepted and duplicate counts and the activities of records completed by this call.
 */
export async function commitRecords(store: LedgerStore, identity: SeatIdentity, records: readonly OtlpLogRecord[], nowMs: number): Promise<CommitResult> {
  bindSeat(store, identity)
  const result: CommitResult = { accepted: 0, duplicates: 0, activities: [] }
  for (const record of records) {
    const meta = readMeta(record, identity)
    if (store.sql('SELECT 1 AS hit FROM parts WHERE record_id = ? AND part = ?', meta.recordId, meta.part).length > 0) {
      result.duplicates++
      continue
    }
    const bytes = meta.parts === 1 ? encoder.encode(record.body!) : decodeBase64(record.body!)
    if (meta.parts === 1 && await sha256Hex(bytes) !== meta.sha256) reject('DIGEST_MISMATCH', 'the record body does not match dsh.record.sha256', 422)
    const earlier = store.sql('SELECT part, object_key FROM parts WHERE record_id = ? ORDER BY part', meta.recordId)
    const complete = earlier.length + 1 === meta.parts
    let full: Uint8Array | undefined
    if (complete && meta.parts > 1) {
      const chunks = new Map<number, Uint8Array>([[meta.part, bytes]])
      for (const row of earlier) {
        const stored = await store.getObject(String(row['object_key']))
        if (stored === null) throw new Error(`stored fragment ${String(row['object_key'])} is missing`)
        chunks.set(Number(row['part']), stored)
      }
      full = concat(Array.from({ length: meta.parts }, (_, index) => {
        const chunk = chunks.get(index)
        if (chunk === undefined) reject('BAD_PART', `fragment ${index} of ${meta.recordId} is missing`)
        return chunk
      }))
      if (await sha256Hex(full) !== meta.sha256) reject('DIGEST_MISMATCH', 'the reassembled record does not match dsh.record.sha256', 422)
    } else if (complete) {
      full = bytes
    }
    let json: string | undefined
    if (full !== undefined) {
      try {
        json = utf8.decode(full)
      } catch (error) {
        reject('BAD_UTF8', `the record is not UTF-8: ${String(error)}`, 422)
      }
    }
    const key = objectKey(identity, meta.sessionId, meta.seq, meta.part, meta.parts, meta.recordId)
    await store.putObject(key, bytes, {
      sha256: meta.sha256, recordId: meta.recordId, part: String(meta.part), parts: String(meta.parts),
      sessionId: meta.sessionId, seq: String(meta.seq), type: meta.type,
      cohort: identity.cohort, student: identity.student, installation: identity.installation,
    })
    const insertPart = (): void => {
      store.sql('INSERT INTO parts (record_id, part, parts, session_id, seq, object_key, bytes, received_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        meta.recordId, meta.part, meta.parts, meta.sessionId, meta.seq, key, bytes.length, nowMs)
    }
    result.accepted++
    if (json === undefined || full === undefined) {
      store.transaction(insertPart)
      continue
    }
    const session = store.sql('SELECT chain, chain_seq FROM sessions WHERE session_id = ?', meta.sessionId)[0]
    const previous = session === undefined ? await genesis(identity.installation, meta.sessionId) : String(session['chain'])
    const previousSeq = session === undefined ? -2 : Number(session['chain_seq'])
    const chain = await nextLink(previous, meta.seq, meta.sha256)
    const summary = summarize(meta.type, json)
    const fullBytes = full.length
    store.transaction(() => {
      insertPart()
      store.sql(`INSERT INTO records (record_id, session_id, seq, event_type, record_sha256, parts, bytes, event_ms, received_ms, chain)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, meta.recordId, meta.sessionId, meta.seq, meta.type, meta.sha256, meta.parts, fullBytes, meta.eventMs, nowMs, chain)
      if (session === undefined) {
        store.sql(`INSERT INTO sessions (session_id, first_ms, last_ms, chain, chain_seq, records, reasoning_chars, tool_calls, tool_errors, scope_denials, title, model)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`, meta.sessionId, nowMs, nowMs, chain, meta.seq, summary.reasoningChars, summary.toolCalls,
        summary.toolErrors, summary.scopeDenials, summary.title ?? null, summary.model ?? null)
      } else {
        store.sql(`UPDATE sessions SET last_ms = ?, chain = ?, chain_seq = ?, records = records + 1, reasoning_chars = reasoning_chars + ?,
          tool_calls = tool_calls + ?, tool_errors = tool_errors + ?, scope_denials = scope_denials + ?, title = COALESCE(?, title),
          model = COALESCE(?, model) WHERE session_id = ?`, nowMs, chain, meta.seq, summary.reasoningChars, summary.toolCalls,
        summary.toolErrors, summary.scopeDenials, summary.title ?? null, summary.model ?? null, meta.sessionId)
      }
      if (meta.seq !== previousSeq + 1) {
        store.sql('INSERT INTO problems (at_ms, session_id, seq, code, detail) VALUES (?, ?, ?, ?, ?)', nowMs, meta.sessionId, meta.seq,
          meta.seq <= previousSeq ? 'SEQUENCE_REPEAT' : 'SEQUENCE_GAP', `expected ${previousSeq + 1}, received ${meta.seq}`)
      }
    })
    result.activities.push({
      ...identity, ...summary, sessionId: meta.sessionId, seq: meta.seq, type: meta.type, eventMs: meta.eventMs, receivedMs: nowMs, recordSha256: meta.sha256,
    })
  }
  return result
}

/** Seat state for readers. */
export interface SeatSummary {
  identity: SeatIdentity | undefined
  revokedMs: number | null
  sessions: Record<string, SqlValue>[]
  problems: Record<string, SqlValue>[]
}

/**
 * Read the seat identity, Session totals, and recorded problems.
 * @param store - The seat's storage.
 * @returns Seat state; `identity` is `undefined` before the first commit.
 */
export function seatSummary(store: LedgerStore): SeatSummary {
  const seat = store.sql('SELECT cohort, student, installation, revoked_ms FROM seat WHERE id = 1')[0]
  return {
    identity: seat === undefined ? undefined : { cohort: String(seat['cohort']), student: String(seat['student']), installation: String(seat['installation']) },
    revokedMs: seat === undefined ? null : seat['revoked_ms'] as number | null,
    sessions: store.sql('SELECT * FROM sessions ORDER BY last_ms DESC'),
    problems: store.sql('SELECT * FROM problems ORDER BY at_ms DESC LIMIT 200'),
  }
}

/**
 * List indexed records of one Session in sequence order.
 * @param store - The seat's storage.
 * @param sessionId - DSH Session id.
 * @param afterSeq - Return records with a greater sequence.
 * @param limit - Maximum rows, 1 to 1000.
 * @returns Record index rows.
 */
export function sessionRecords(store: LedgerStore, sessionId: string, afterSeq: number, limit: number): Record<string, SqlValue>[] {
  return store.sql('SELECT seq, event_type, record_id, record_sha256, parts, bytes, event_ms, received_ms, chain FROM records WHERE session_id = ? AND seq > ? ORDER BY seq, received_ms LIMIT ?',
    sessionId, afterSeq, Math.max(1, Math.min(1000, limit)))
}

/**
 * Reassemble the exact bytes of the first committed record at one sequence.
 * @param store - The seat's storage.
 * @param sessionId - DSH Session id.
 * @param seq - Event sequence.
 * @returns The record bytes, or `null` when no complete record exists.
 */
export async function readRecord(store: LedgerStore, sessionId: string, seq: number): Promise<Uint8Array | null> {
  const record = store.sql('SELECT record_id FROM records WHERE session_id = ? AND seq = ? ORDER BY received_ms LIMIT 1', sessionId, seq)[0]
  if (record === undefined) return null
  const parts = store.sql('SELECT object_key FROM parts WHERE record_id = ? ORDER BY part', String(record['record_id']))
  const chunks: Uint8Array[] = []
  for (const row of parts) {
    const bytes = await store.getObject(String(row['object_key']))
    if (bytes === null) throw new Error(`stored part ${String(row['object_key'])} is missing`)
    chunks.push(bytes)
  }
  return concat(chunks)
}

/**
 * Revoke the seat; later commits fail with `SEAT_REVOKED`.
 * @param store - The seat's storage.
 * @param reason - Operator reason.
 * @param nowMs - Revocation time in milliseconds.
 * @returns Whether a bound seat existed to revoke.
 */
export function revokeSeat(store: LedgerStore, reason: string, nowMs: number): boolean {
  if (store.sql('SELECT 1 AS hit FROM seat WHERE id = 1').length === 0) return false
  store.sql('UPDATE seat SET revoked_ms = ?, revoked_reason = ? WHERE id = 1', nowMs, reason)
  return true
}
