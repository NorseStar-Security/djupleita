import assert from 'node:assert/strict'
import { test } from 'node:test'
import { commitRecords, migrate, RecordRejected } from '../src/ledger.ts'
import type { OtlpLogRecord } from '../src/otlp.ts'
import { signToken, TokenError, verifyToken, type TokenClaims } from '../src/token.ts'
import { writerIdentity, WriterRejected } from '../src/writer.ts'
import { memoryStore } from './helpers.ts'

const KEY = 'k'.repeat(48)
const NOW = 1_800_000_000
const course: TokenClaims = { kind: 'course', cohort: 'sec590', student: '', installation: 'sans-', expiresAt: NOW + 3600, nonce: 'nonce-0003' }

function record(source: unknown): OtlpLogRecord {
  return { timeUnixNano: undefined, eventName: '', body: undefined, attributes: { 'dsh.source.id': source as string } }
}

test('a course token signs and verifies with its cohort and seat prefix', async () => {
  assert.deepEqual(await verifyToken(KEY, await signToken(KEY, course), NOW), course)
  await assert.rejects(signToken(KEY, { ...course, student: 'someone' }), TokenError)
  await assert.rejects(signToken(KEY, { ...course, cohort: '*' }), TokenError)
  await assert.rejects(signToken(KEY, { ...course, installation: '' }), TokenError)
})

test('a course token writes as the seat named by dsh.source.id, one student per seat', () => {
  assert.deepEqual(writerIdentity(course, [record('sans-i-0abc')]), { cohort: 'sec590', student: 'sans-i-0abc', installation: 'sans-i-0abc' })
})

test('a course token cannot write outside its prefix, so the author rig seat stays its own', () => {
  assert.throws(() => writerIdentity(course, [record('webtop-personas')]), (e: unknown) => e instanceof WriterRejected && e.status === 403)
  assert.throws(() => writerIdentity(course, [record('sans-')]), (e: unknown) => e instanceof WriterRejected && e.status === 403)
  assert.throws(() => writerIdentity(course, [record('../x')]), (e: unknown) => e instanceof WriterRejected && e.status === 400)
  assert.throws(() => writerIdentity(course, [record(7)]), (e: unknown) => e instanceof WriterRejected && e.status === 400)
})

test('seat tokens keep their own identity; board and admin tokens cannot write', () => {
  const seat: TokenClaims = { kind: 'seat', cohort: 'pilot', student: 'pedram', installation: 'webtop-personas', expiresAt: NOW + 60, nonce: 'nonce-0004' }
  assert.deepEqual(writerIdentity(seat, [record('anything')]), { cohort: 'pilot', student: 'pedram', installation: 'webtop-personas' })
  for (const kind of ['board', 'admin'] as const) {
    assert.throws(() => writerIdentity({ ...seat, kind, student: '', installation: '' }, [record('sans-a')]), (e: unknown) => e instanceof WriterRejected && e.status === 403)
  }
})

test('a request mixing two seats is refused by the ledger after the first record names the seat', async () => {
  const store = memoryStore()
  migrate(store)
  const identity = writerIdentity(course, [record('sans-a'), record('sans-b')])
  const mixed: OtlpLogRecord[] = [{ ...record('sans-b'), attributes: { 'dsh.trajectory.schema': 1, 'dsh.source.id': 'sans-b' } }]
  await assert.rejects(commitRecords(store, identity, mixed, 1000), (e: unknown) => e instanceof RecordRejected && e.status === 403)
})
