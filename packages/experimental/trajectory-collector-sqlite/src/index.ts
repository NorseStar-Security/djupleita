/** Durable instructor-side collector; synchronous transactions own each intake commit. */
import { createHash } from 'node:crypto'
import { constants, closeSync, lstatSync, mkdirSync, openSync, statfsSync, statSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { CollectorError, TrajectoryCollector } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type { CohortId, CollectedArtifact, CollectedRecord, CollectorIdentity, CollectorPage, CollectorQuery, CollectorReceipt, CollectorStatus, InstallationId, StudentId, TrajectoryArtifactId, TrajectoryRecord, TrajectoryRecordId } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'

/** Local disk ownership, intake quotas, and complete inspection-page budgets. */
export interface Config {
  /** Absolute database path in a dedicated owner-only directory; network filesystems are unsupported. */
  path: string
  /** Maximum retained record identities, including pruned deduplication tombstones. */
  maxRecords: number
  /** Maximum installation bindings and revocation entries. */
  maxInstallations: number
  /** Maximum retained artifact count. */
  maxArtifacts: number
  /** Maximum live record-content and artifact bytes together. */
  maxContentBytes: number
  /** Maximum complete submitted record-envelope UTF-8 bytes. */
  maxRecordBytes: number
  /** Maximum complete binary artifact bytes. */
  maxArtifactBytes: number
  /** Maximum database, WAL, and shared-memory bytes; writes reserve additional space conservatively. */
  maxDatabaseBytes: number
  /** Minimum filesystem free bytes preserved in addition to a conservative write reservation. */
  minFreeBytes: number
  /** Maximum records requested in one inspection page. */
  maxReadRecords: number
  /** Maximum complete serialized inspection-page bytes. */
  maxReadBytes: number
  /** SQLite write-lock deadline; concurrent processes fail visibly rather than silently retrying intake. */
  busyTimeoutMs: number
}

const size = () => z.natural().min(1).max(Number.MAX_SAFE_INTEGER)
const applicationId = 0x44534854
const schemaVersion = 1
const tables = ['artifacts', 'collector_state', 'installations', 'records', 'sessions']

interface State extends Record<string, SQLOutputValue> { last_cursor: number; exported_cursor: number; destination: string | null }
interface RecordRow extends Record<string, SQLOutputValue> {
  cursor: number
  id: string
  installation: string
  student: string
  cohort: string
  session: string
  sequence: number
  type: string
  timestamp: number
  content: string
  digest: string
  envelope_digest: string
  received_at: number
}
interface InstallationRow { student: string | null; cohort: string | null; revoked: number }
interface ArtifactRow { digest: string; name: string; data: Uint8Array; received_at: number; student: string; cohort: string }

function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex') }
function input(message: string): never { throw new CollectorError('COLLECTOR_INPUT', message) }
function quota(): never { throw new CollectorError('COLLECTOR_QUOTA', 'Collector capacity exhausted; stop uploads and ask the instructor to archive or expand storage. No new content committed.') }
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function privateEntry(path: string, directory: boolean): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (process.platform !== 'win32' && (info.mode & 0o077 || info.uid !== process.getuid?.()))) {
    throw new CollectorError('COLLECTOR_STORAGE', 'Collector paths must be owner-only real directories and files; correct permissions before loading.')
  }
}

function openDatabase(config: Config): DatabaseSync {
  mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 })
  privateEntry(dirname(config.path), true)
  try { closeSync(openSync(config.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  privateEntry(config.path, false)
  const db = new DatabaseSync(config.path)
  try {
    const app = db.prepare('PRAGMA application_id').get() as { application_id: number }
    const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
    const existing = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name)
    const empty = app.application_id === 0 && version.user_version === 0 && existing.length === 0
    const supported = app.application_id === applicationId && version.user_version === schemaVersion
      && JSON.stringify(existing) === JSON.stringify(tables)
    if (!empty && !supported) {
      throw new CollectorError('COLLECTOR_STORAGE', 'The database is foreign or has an unsupported collector schema; preserve it and select the correct archive.')
    }
    db.exec(`PRAGMA busy_timeout=${config.busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=128; PRAGMA journal_size_limit=0;`)
    const page = db.prepare('PRAGMA page_size').get() as { page_size: number }
    db.exec(`PRAGMA max_page_count=${Math.floor(config.maxDatabaseBytes / page.page_size)}`)
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS collector_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), last_cursor INTEGER NOT NULL, exported_cursor INTEGER NOT NULL, destination TEXT) STRICT;
      INSERT OR IGNORE INTO collector_state VALUES(1,0,0,NULL);
      CREATE TABLE IF NOT EXISTS installations (installation TEXT PRIMARY KEY, student TEXT, cohort TEXT, revoked INTEGER NOT NULL CHECK(revoked IN(0,1))) STRICT;
      CREATE TABLE IF NOT EXISTS sessions (installation TEXT NOT NULL REFERENCES installations(installation), session TEXT NOT NULL, next_sequence INTEGER NOT NULL, PRIMARY KEY(installation,session)) STRICT;
      CREATE TABLE IF NOT EXISTS records (cursor INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, installation TEXT NOT NULL REFERENCES installations(installation), session TEXT NOT NULL, sequence INTEGER NOT NULL, type TEXT NOT NULL, timestamp REAL NOT NULL, content TEXT, content_bytes INTEGER NOT NULL, digest TEXT NOT NULL, envelope_digest TEXT NOT NULL, received_at INTEGER NOT NULL, UNIQUE(installation,session,sequence)) STRICT;
      CREATE INDEX IF NOT EXISTS records_filter ON records(installation,session,cursor);
      CREATE TABLE IF NOT EXISTS artifacts (installation TEXT NOT NULL REFERENCES installations(installation), digest TEXT NOT NULL, name TEXT NOT NULL, data BLOB NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY(installation,digest)) STRICT;
      PRAGMA application_id=${applicationId}; PRAGMA user_version=${schemaVersion}; COMMIT;`)
    return db
  } catch (error) { db.close(); throw error }
}

/** SQLite Service Provider with durable replay protection, revocation, and export acknowledgements. */
export default class SqliteTrajectoryCollector extends TrajectoryCollector {
  static Config: z<Partial<Config>, Config> = z.object({
    path: z.transform(z.string().required(), (value) => { if (!isAbsolute(value)) throw new Error('collector path must be absolute'); return value }),
    maxRecords: size().default(1_000_000), maxInstallations: size().default(10_000), maxArtifacts: size().default(10_000),
    maxContentBytes: size().default(512 * 1024 * 1024), maxRecordBytes: size().default(1024 * 1024),
    maxArtifactBytes: size().default(16 * 1024 * 1024), maxDatabaseBytes: size().min(65536).default(1024 * 1024 * 1024),
    minFreeBytes: z.natural().max(Number.MAX_SAFE_INTEGER).default(64 * 1024 * 1024),
    maxReadRecords: size().max(10_000).default(128), maxReadBytes: size().default(4 * 1024 * 1024),
    busyTimeoutMs: z.natural().max(2_147_483_647).default(1000),
  })

  private readonly db: DatabaseSync
  private closed = false

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    try { this.db = openDatabase(config) }
    catch (error) { throw error instanceof CollectorError ? error : new CollectorError('COLLECTOR_STORAGE', 'Collector storage could not open; preserve the archive and ask the instructor to restore storage.', { cause: error }) }
    ctx.effect(() => () => { if (!this.closed) { this.closed = true; this.db.close() } })
  }

  private run<T>(operation: () => T): Promise<T> {
    // The Promise boundary preserves service rejection semantics; transactions still finish synchronously before returning.
    return new Promise((resolve) => {
      if (this.closed) throw new CollectorError('COLLECTOR_UNAVAILABLE', 'Collector is closed; reload the configured archive before continuing.')
      try { resolve(operation()) }
      catch (error) {
        if (error instanceof CollectorError) throw error
        this.closed = true
        this.db.close()
        throw new CollectorError('COLLECTOR_STORAGE', 'Collector storage failed and intake stopped; no success is acknowledged. Preserve the archive and ask the instructor to restore storage before reload.', { cause: error })
      }
    })
  }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try { const value = operation(); this.db.exec('COMMIT'); return value }
    catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  private state(): State { return this.db.prepare('SELECT last_cursor,exported_cursor,destination FROM collector_state WHERE singleton=1').get() as State }

  private capacity(reservation: number): void {
    const filesystem = statfsSync(dirname(this.config.path))
    if (filesystem.bavail * filesystem.bsize < this.config.minFreeBytes + reservation * 4 + 65536) quota()
    let bytes = statSync(this.config.path).size
    for (const suffix of ['-wal', '-shm']) {
      try { bytes += statSync(this.config.path + suffix).size }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    if (bytes + reservation * 4 + 65536 > this.config.maxDatabaseBytes) quota()
  }

  private count(table: 'records' | 'installations' | 'artifacts'): number { return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count }
  private contentBytes(): number { return (this.db.prepare('SELECT (SELECT COALESCE(SUM(content_bytes),0) FROM records)+(SELECT COALESCE(SUM(length(data)),0) FROM artifacts) AS bytes').get() as { bytes: number }).bytes }

  private bind(identity: CollectorIdentity): void {
    const prior = this.db.prepare('SELECT student,cohort,revoked FROM installations WHERE installation=?').get(identity.installationId) as InstallationRow | undefined
    if (prior?.revoked) throw new CollectorError('COLLECTOR_REVOKED', 'This installation is revoked; existing evidence is retained and future writes are denied.')
    if (prior) {
      if (prior.student !== identity.studentId || prior.cohort !== identity.cohortId) throw new CollectorError('COLLECTOR_CONFLICT', 'An installation cannot change its trusted student or cohort identity.')
    } else {
      if (this.count('installations') >= this.config.maxInstallations) quota()
      this.db.prepare('INSERT INTO installations VALUES(?,?,?,0)').run(identity.installationId, identity.studentId, identity.cohortId)
    }
  }

  override append(identity: CollectorIdentity, record: TrajectoryRecord): Promise<CollectorReceipt> {
    return this.run(() => {
      if (Buffer.byteLength(JSON.stringify(record)) > this.config.maxRecordBytes) quota()
      if (!record.sessionId || !record.type || !Number.isSafeInteger(record.sequence) || record.sequence < -1 || !Number.isFinite(record.timestamp) || record.timestamp < 0) input('Record metadata must identify a session, type, sequence, and finite timestamp.')
      let value: unknown
      try { value = JSON.parse(record.content) } catch { input('Record content must be one complete JSON object; nothing was committed.') }
      if (!object(value)) input('Record content must be one complete JSON object; nothing was committed.')
      if (record.sequence === -1) {
        if (record.type !== 'session/header' || !object(value.header) || value.header.id !== record.sessionId || value.header.createdAt !== record.timestamp || !Number.isSafeInteger(value.inheritedEventCount) || Number(value.inheritedEventCount) < 0) input('Header metadata must match its complete session header and inherited-event count.')
      } else if (record.type === 'session/header' || value.seq !== record.sequence || value.type !== record.type || value.time !== record.timestamp) input('Event sequence, type, and time must match the complete event content.')
      const sha256 = digest(record.content)
      const envelope = digest(JSON.stringify([
        identity.installationId, identity.studentId, identity.cohortId,
        record.sessionId, record.sequence, record.type, record.timestamp, record.content,
      ]))
      return this.transaction(() => {
        this.bind(identity)
        const prior = this.db.prepare('SELECT id,digest,envelope_digest FROM records WHERE installation=? AND session=? AND sequence=?').get(identity.installationId, record.sessionId, record.sequence) as Pick<RecordRow, 'id' | 'digest' | 'envelope_digest'> | undefined
        if (prior) {
          if (prior.envelope_digest !== envelope) throw new CollectorError('COLLECTOR_CONFLICT', 'A committed record cannot change its original content or metadata.')
          return { id: brandString<TrajectoryRecordId>(prior.id), sha256: prior.digest, duplicate: true }
        }
        const session = this.db.prepare('SELECT next_sequence FROM sessions WHERE installation=? AND session=?').get(identity.installationId, record.sessionId) as { next_sequence: number } | undefined
        if ((record.sequence === -1 && session) || (record.sequence !== -1 && (!session || session.next_sequence !== record.sequence))) throw new CollectorError('COLLECTOR_CONFLICT', 'Commit the header first, then upload contiguous original event sequences without gaps.')
        if (this.count('records') >= this.config.maxRecords || this.contentBytes() + Buffer.byteLength(record.content) > this.config.maxContentBytes) quota()
        this.capacity(Buffer.byteLength(JSON.stringify([identity, record])))
        const cursor = this.state().last_cursor + 1
        if (!Number.isSafeInteger(cursor) || record.sequence >= Number.MAX_SAFE_INTEGER) quota()
        const id = digest(JSON.stringify([identity.installationId, record.sessionId, record.sequence]))
        this.db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(cursor, id, identity.installationId, record.sessionId, record.sequence, record.type, record.timestamp, record.content, Buffer.byteLength(record.content), sha256, envelope, Date.now())
        if (record.sequence === -1) this.db.prepare('INSERT INTO sessions VALUES(?,?,0)').run(identity.installationId, record.sessionId)
        else this.db.prepare('UPDATE sessions SET next_sequence=? WHERE installation=? AND session=?').run(record.sequence + 1, identity.installationId, record.sessionId)
        this.db.prepare('UPDATE collector_state SET last_cursor=? WHERE singleton=1').run(cursor)
        return { id: brandString<TrajectoryRecordId>(id), sha256, duplicate: false }
      })
    })
  }

  override read(query: CollectorQuery): Promise<CollectorPage> {
    return this.run(() => {
      if (!Number.isSafeInteger(query.after) || query.after < 0 || !Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > this.config.maxReadRecords || !Number.isSafeInteger(query.maxBytes) || query.maxBytes < 1 || query.maxBytes > this.config.maxReadBytes) input('Use bounded positive page limits and a nonnegative committed cursor.')
      const filters: string[] = ['r.cursor>?', 'r.content IS NOT NULL']
      const parameters: (string | number)[] = [query.after]
      for (const [column, value] of [['r.installation', query.installationId], ['i.student', query.studentId], ['i.cohort', query.cohortId], ['r.session', query.sessionId]] as const) {
        if (value !== undefined) { filters.push(`${column}=?`); parameters.push(value) }
      }
      const rows = this.db.prepare(`SELECT r.*,i.student,i.cohort FROM records r JOIN installations i ON i.installation=r.installation WHERE ${filters.join(' AND ')} ORDER BY r.cursor LIMIT ?`).all(...parameters, query.limit + 1) as RecordRow[]
      const page: CollectorPage = { records: [], nextCursor: query.after, hasMore: rows.length > 0 }
      for (const row of rows.slice(0, query.limit)) {
        const record: CollectedRecord = {
          id: brandString<TrajectoryRecordId>(row.id), cursor: row.cursor, sha256: row.digest, receivedAt: row.received_at,
          identity: {
            installationId: brandString<InstallationId>(row.installation),
            studentId: brandString<StudentId>(row.student), cohortId: brandString<CohortId>(row.cohort),
          },
          sessionId: brandString<SessionId>(row.session), sequence: row.sequence, type: row.type,
          timestamp: row.timestamp, content: row.content,
        }
        const next = { records: [...page.records, record], nextCursor: row.cursor, hasMore: rows.length > page.records.length + 1 }
        if (Buffer.byteLength(JSON.stringify(next)) > query.maxBytes) { if (!page.records.length) quota(); break }
        Object.assign(page, next)
      }
      if (Buffer.byteLength(JSON.stringify(page)) > query.maxBytes) quota()
      return page
    })
  }

  override putArtifact(
    identity: CollectorIdentity, artifact: { sha256: string; name: string; data: Uint8Array },
  ): Promise<TrajectoryArtifactId> {
    return this.run(() => {
      if (artifact.data.byteLength > this.config.maxArtifactBytes) quota()
      if (!/^[a-f0-9]{64}$/.test(artifact.sha256) || digest(artifact.data) !== artifact.sha256 || !artifact.name || Buffer.byteLength(artifact.name) > 256 || /[\x00-\x1f\x7f]/.test(artifact.name)) input('Artifacts require a matching SHA-256 digest and a bounded display name without control characters.')
      return this.transaction(() => {
        this.bind(identity)
        const prior = this.db.prepare('SELECT name,data FROM artifacts WHERE installation=? AND digest=?').get(identity.installationId, artifact.sha256) as Pick<ArtifactRow, 'name' | 'data'> | undefined
        if (prior) {
          if (prior.name !== artifact.name || !Buffer.from(prior.data).equals(artifact.data)) throw new CollectorError('COLLECTOR_CONFLICT', 'A committed artifact cannot change its bytes or display name.')
          return brandString<TrajectoryArtifactId>(artifact.sha256)
        }
        if (this.count('artifacts') >= this.config.maxArtifacts || this.contentBytes() + artifact.data.byteLength > this.config.maxContentBytes) quota()
        this.capacity(artifact.data.byteLength + Buffer.byteLength(JSON.stringify([identity, artifact.name])))
        this.db.prepare('INSERT INTO artifacts VALUES(?,?,?,?,?)').run(identity.installationId, artifact.sha256, artifact.name, artifact.data, Date.now())
        return brandString<TrajectoryArtifactId>(artifact.sha256)
      })
    })
  }

  override getArtifact(installation: InstallationId, id: TrajectoryArtifactId): Promise<CollectedArtifact | undefined> {
    return this.run(() => {
      const row = this.db.prepare('SELECT a.*,i.student,i.cohort FROM artifacts a JOIN installations i ON i.installation=a.installation WHERE a.installation=? AND a.digest=?').get(installation, id) as ArtifactRow | undefined
      return row ? {
        id, sha256: row.digest, name: row.name, receivedAt: row.received_at,
        identity: {
          installationId: installation, studentId: brandString<StudentId>(row.student), cohortId: brandString<CohortId>(row.cohort),
        },
        data: Uint8Array.from(row.data),
      } : undefined
    })
  }

  override revoke(installation: InstallationId): Promise<void> {
    return this.run(() =>{  this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM installations WHERE installation=?').get(installation) && this.count('installations') >= this.config.maxInstallations) quota()
      this.capacity(Buffer.byteLength(installation))
      this.db.prepare('INSERT INTO installations VALUES(?,NULL,NULL,1) ON CONFLICT(installation) DO UPDATE SET revoked=1').run(installation)
    }) })
  }

  override isRevoked(installation: InstallationId): Promise<boolean> { return this.run(() => Boolean((this.db.prepare('SELECT revoked FROM installations WHERE installation=?').get(installation) as { revoked: number } | undefined)?.revoked)) }

  override status(): Promise<CollectorStatus> {
    return this.run(() => {
      const state = this.state()
      return { records: (this.db.prepare('SELECT COUNT(*) AS count FROM records WHERE content IS NOT NULL').get() as { count: number }).count, artifacts: this.count('artifacts'), contentBytes: this.contentBytes(), revokedInstallations: (this.db.prepare('SELECT COUNT(*) AS count FROM installations WHERE revoked=1').get() as { count: number }).count, lastCursor: state.last_cursor, exportedCursor: state.exported_cursor, exportDestination: state.destination }
    })
  }

  private destination(value: string): void { if (!value || Buffer.byteLength(value) > 256) input('Use a nonempty destination fingerprint of at most 256 UTF-8 bytes, without secrets.') }

  override markExported(destination: string, cursor: number): Promise<void> {
    return this.run(() =>{  this.transaction(() => {
      this.destination(destination)
      const state = this.state()
      if ((state.destination !== null && state.destination !== destination) || !Number.isSafeInteger(cursor) || cursor < state.exported_cursor || cursor > state.last_cursor) throw new CollectorError('COLLECTOR_CONFLICT', 'Export destination is immutable and acknowledgements must advance through committed cursors.')
      this.capacity(Buffer.byteLength(destination))
      this.db.prepare('UPDATE collector_state SET destination=?,exported_cursor=? WHERE singleton=1').run(destination, cursor)
    }) })
  }

  override pruneExported(destination: string, before: number): Promise<number> {
    return this.run(() => this.transaction(() => {
      this.destination(destination)
      if (!Number.isFinite(before) || before < 0) input('Pruning requires a finite nonnegative receipt-time cutoff.')
      const state = this.state()
      if (state.destination !== destination) throw new CollectorError('COLLECTOR_CONFLICT', 'Pruning requires the bound primary export destination.')
      const row = this.db.prepare('SELECT MIN(cursor) AS first FROM records WHERE cursor<=? AND received_at>=?').get(state.exported_cursor, before) as { first: number | null }
      const cutoff = row.first === null ? state.exported_cursor : row.first - 1
      if (!this.db.prepare('SELECT 1 FROM records WHERE cursor<=? AND sequence>=0 AND content IS NOT NULL LIMIT 1').get(cutoff)) return 0
      // Even deletion can rewrite every database page into WAL; reserve the complete logical database, not only removed bytes.
      const pages = this.db.prepare('PRAGMA page_count').get() as { page_count: number }
      const page = this.db.prepare('PRAGMA page_size').get() as { page_size: number }
      this.capacity(pages.page_count * page.page_size)
      return Number(this.db.prepare('UPDATE records SET content=NULL,content_bytes=0 WHERE cursor<=? AND sequence>=0 AND content IS NOT NULL').run(cutoff).changes)
    }))
  }
}
