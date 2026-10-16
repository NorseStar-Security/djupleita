/** Lifecycle-owned, read-only persistence scans with bounded, disposable revision caches. */
import { setTimeout as delay } from 'node:timers/promises'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { TrajectoryCollector } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type { CollectorIdentity } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionPersistenceRevision, SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import type { Config } from './index.ts'
import { copyAttachments } from './attachments.ts'

interface Cursor {
  offset: number
  headerAcknowledged: boolean
  completeRevision?: SessionPersistenceRevision
}

/** One instance owns every read handle, collector commit, and ephemeral scan cursor. */
export class SessionArchive {
  private readonly cursors = new Map<SessionId, Cursor>()
  private afterSession: SessionId | undefined

  constructor(
    private readonly persistence: SessionPersistence,
    private readonly collector: TrajectoryCollector,
    private readonly identity: CollectorIdentity,
    private readonly config: Config,
    private readonly attachments: AttachmentStore | undefined,
  ) {}

  /** Poll until cancelled; any source, binary, or collector failure stops this owner.
   * @param signal - plugin lifetime.
   */
  async run(signal: AbortSignal): Promise<void> {
    for (;;) {
      await this.scan(signal)
      await delay(this.config.pollIntervalMs, undefined, { signal })
    }
  }

  /** Visit a bounded rotating subset of all persisted sessions.
   * @param signal - cancellation for reads and attachment work.
   */
  async scan(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const snapshots = [...await this.persistence.list({ signal })].sort((left, right) =>
      Number(left.header.id > right.header.id) - Number(left.header.id < right.header.id))
    const after = this.afterSession
    const found = after === undefined ? 0 : snapshots.findIndex(value => value.header.id > after)
    const start = found < 0 ? 0 : found
    const selected = [...snapshots.slice(start), ...snapshots.slice(0, start)].slice(0, this.config.maxSessionsPerScan)
    for (const snapshot of selected) {
      signal.throwIfAborted()
      await this.visit(snapshot, signal)
      this.afterSession = snapshot.header.id
    }
  }

  private async visit(snapshot: SessionPersistenceSnapshot, signal: AbortSignal): Promise<void> {
    const id = snapshot.header.id
    const cursor = this.cursors.get(id) ?? { offset: 0, headerAcknowledged: false }
    this.cursors.delete(id)
    this.cursors.set(id, cursor)
    if (this.cursors.size > this.config.maxCachedSessions) {
      for (const oldest of this.cursors.keys()) {
        this.cursors.delete(oldest)
        break
      }
    }
    if (cursor.completeRevision === snapshot.revision) return

    const handle = await this.persistence.open(id, 'read', { signal })
    try {
      signal.throwIfAborted()
      if (!cursor.headerAcknowledged) {
        await this.collector.append(this.identity, {
          sessionId: id, sequence: -1, type: 'session/header', timestamp: handle.header.createdAt,
          content: JSON.stringify({ header: handle.header, inheritedEventCount: handle.inheritedEventCount }),
        })
        signal.throwIfAborted()
        cursor.headerAcknowledged = true
      }
      const { events } = await handle.read(cursor.offset, this.config.eventsPerRead, { signal })
      for (const event of events) {
        signal.throwIfAborted()
        if (this.attachments !== undefined) {
          await copyAttachments(event, this.attachments, this.collector, this.identity, this.config, signal)
        }
        signal.throwIfAborted()
        await this.collector.append(this.identity, {
          sessionId: id, sequence: event.seq, type: event.type, timestamp: event.time, content: JSON.stringify(event),
        })
        signal.throwIfAborted()
        cursor.offset = event.seq + 1
      }
      if (events.length < this.config.eventsPerRead) cursor.completeRevision = snapshot.revision
    } finally {
      await handle.close()
    }
  }
}
