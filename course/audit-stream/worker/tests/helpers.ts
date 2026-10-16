/** Shared fixtures: exporter-encoded requests and an in-memory ledger store over node:sqlite. */
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { LedgerStore, SqlValue } from '../src/ledger.ts'

/** One exporter-encoded record and its requests. */
export interface FixtureCase {
  name: string
  sourceId: string
  sessionId: string
  seq: number
  type: string
  fragmentBytes: number
  record: string
  requests: string[]
}

/** Cases produced by `tests/fixtures/generate.ts`. */
export const fixtures: FixtureCase[] = (JSON.parse(readFileSync(new URL('./fixtures/otlp-requests.json', import.meta.url), 'utf8')) as { cases: FixtureCase[] }).cases

/**
 * Find a fixture case by name.
 * @param name - Case name.
 * @returns The case.
 */
export function fixture(name: string): FixtureCase {
  const found = fixtures.find((entry) => entry.name === name)
  if (found === undefined) throw new Error(`missing fixture ${name}`)
  return found
}

/**
 * Decode a base64 request body.
 * @param text - Base64 text.
 * @returns The bytes.
 */
export function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}

/** An in-memory {@link LedgerStore} with an inspectable object map. */
export interface MemoryStore extends LedgerStore {
  objects: Map<string, { bytes: Uint8Array, metadata: Record<string, string> }>
  /** Make the next `putObject` reject, to simulate a storage outage. */
  failNextPut: boolean
}

/**
 * Create an empty in-memory store.
 * @returns The store.
 */
export function memoryStore(): MemoryStore {
  const db = new DatabaseSync(':memory:')
  const objects = new Map<string, { bytes: Uint8Array, metadata: Record<string, string> }>()
  const store: MemoryStore = {
    objects,
    failNextPut: false,
    sql(query: string, ...params: SqlValue[]) {
      const statement = db.prepare(query)
      return /^\s*(SELECT|WITH|PRAGMA)/i.test(query)
        ? statement.all(...params) as Record<string, SqlValue>[]
        : (statement.run(...params), [])
    },
    transaction<T>(body: () => T): T {
      db.exec('BEGIN')
      try {
        const value = body()
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    },
    async putObject(key: string, bytes: Uint8Array, metadata: Record<string, string>) {
      if (store.failNextPut) {
        store.failNextPut = false
        throw new Error('simulated storage outage')
      }
      const existing = objects.get(key)
      if (existing !== undefined) {
        if (existing.metadata['sha256'] === metadata['sha256'] && existing.metadata['part'] === metadata['part']) return
        throw new Error(`object ${key} already holds different content`)
      }
      objects.set(key, { bytes: new Uint8Array(bytes), metadata: { ...metadata } })
    },
    async getObject(key: string) {
      return objects.get(key)?.bytes ?? null
    },
  }
  return store
}
