/** The per-installation Durable Object that owns one seat's ledger. */
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env.ts'
import {
  commitRecords, migrate, readRecord, RecordRejected, revokeSeat, seatSummary, sessionRecords,
  type CommitResult, type LedgerStore, type SeatIdentity, type SeatSummary, type SqlValue,
} from './ledger.ts'
import type { OtlpLogRecord } from './otlp.ts'

/** Commit outcome; rejections travel as data because RPC drops custom error fields. */
export type CommitOutcome =
  | { ok: true, result: CommitResult }
  | { ok: false, code: string, status: number, message: string }

/** Serializes commits for one installation over Durable Object SQLite and the R2 bucket. */
export class SeatLedger extends DurableObject<Env> {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly store: LedgerStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const bucket = env.RAW
    this.store = {
      sql: (query, ...params) => ctx.storage.sql.exec(query, ...params).toArray() as Record<string, SqlValue>[],
      transaction: (body) => ctx.storage.transactionSync(body),
      async putObject(key, bytes, metadata) {
        const existing = await bucket.head(key)
        if (existing !== null) {
          if (existing.customMetadata?.['sha256'] === metadata['sha256'] && existing.customMetadata?.['part'] === metadata['part']) return
          throw new Error(`object ${key} already holds different content`)
        }
        await bucket.put(key, bytes, { customMetadata: metadata, httpMetadata: { contentType: 'application/octet-stream' } })
      },
      async getObject(key) {
        const object = await bucket.get(key)
        return object === null ? null : new Uint8Array(await object.arrayBuffer())
      },
    }
    void ctx.blockConcurrencyWhile(async () => { migrate(this.store) })
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Commit one request's records after earlier commits for this seat settle.
   * @param identity - Trusted identity from the verified seat token.
   * @param records - Decoded OTLP log records.
   * @returns The commit result, or a non-retryable rejection.
   */
  commit(identity: SeatIdentity, records: OtlpLogRecord[]): Promise<CommitOutcome> {
    return this.serial(async () => {
      try {
        return { ok: true, result: await commitRecords(this.store, identity, records, Date.now()) }
      } catch (error) {
        if (error instanceof RecordRejected) return { ok: false, code: error.code, status: error.status, message: error.message }
        throw error
      }
    })
  }

  /**
   * Read the seat identity, Session totals, and problems.
   * @returns Seat state.
   */
  summary(): SeatSummary {
    return seatSummary(this.store)
  }

  /**
   * List one Session's indexed records.
   * @param sessionId - DSH Session id.
   * @param afterSeq - Return records after this sequence.
   * @param limit - Maximum rows.
   * @returns Record index rows.
   */
  records(sessionId: string, afterSeq: number, limit: number): Record<string, SqlValue>[] {
    return sessionRecords(this.store, sessionId, afterSeq, limit)
  }

  /**
   * Reassemble one record's exact bytes.
   * @param sessionId - DSH Session id.
   * @param seq - Event sequence.
   * @returns The bytes, or `null` when no complete record exists.
   */
  raw(sessionId: string, seq: number): Promise<Uint8Array | null> {
    return readRecord(this.store, sessionId, seq)
  }

  /**
   * Revoke this seat.
   * @param reason - Operator reason.
   * @returns Whether a bound seat existed.
   */
  revoke(reason: string): Promise<boolean> {
    return this.serial(async () => revokeSeat(this.store, reason, Date.now()))
  }
}
