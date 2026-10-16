import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  commitRecords, genesis, migrate, nextLink, readRecord, RecordRejected, revokeSeat, seatSummary, sessionRecords, type SeatIdentity,
} from '../src/ledger.ts'
import { decodeLogsProtobuf, type OtlpLogRecord } from '../src/otlp.ts'
import { bytesOf, fixture, memoryStore } from './helpers.ts'

const seat: SeatIdentity = { cohort: 'pilot', student: 'seat-01', installation: 'seat-fixture' }

function decode(name: string): OtlpLogRecord[] {
  return fixture(name).requests.flatMap((request) => decodeLogsProtobuf(bytesOf(request)))
}

function ready() {
  const store = memoryStore()
  migrate(store)
  return store
}

test('a complete record is stored byte-exact, indexed, chained, and summarized', async () => {
  const store = ready()
  const header = decode('header')
  const result = await commitRecords(store, seat, header, 1000)
  assert.equal(result.accepted, 1)
  assert.equal(result.duplicates, 0)
  assert.equal(result.activities.length, 1)
  assert.equal(result.activities[0]!.type, 'session')
  const [object] = [...store.objects.values()]
  assert.equal(Buffer.from(object!.bytes).toString('utf8'), fixture('header').record)
  assert.equal(createHash('sha256').update(object!.bytes).digest('hex'), header[0]!.attributes['dsh.record.sha256'])
  const rows = sessionRecords(store, 'fixture-session', -2, 10)
  assert.equal(rows.length, 1)
  const expected = await nextLink(await genesis(seat.installation, 'fixture-session'), -1, String(header[0]!.attributes['dsh.record.sha256']))
  assert.equal(rows[0]!['chain'], expected)
  assert.equal(seatSummary(store).sessions[0]!['chain'], expected)
})

test('replayed records are acknowledged as duplicates without new objects or chain links', async () => {
  const store = ready()
  await commitRecords(store, seat, decode('header'), 1000)
  const replay = await commitRecords(store, seat, decode('header'), 2000)
  assert.equal(replay.accepted, 0)
  assert.equal(replay.duplicates, 1)
  assert.equal(replay.activities.length, 0)
  assert.equal(store.objects.size, 1)
  assert.equal(seatSummary(store).sessions[0]!['records'], 1)
})

test('fragments complete only when every part arrives, then verify against the record digest', async () => {
  const store = ready()
  const parts = decode('assistant-reasoning-fragmented')
  for (const [index, part] of parts.entries()) {
    const result = await commitRecords(store, seat, [part], 1000 + index)
    assert.equal(result.activities.length, index === parts.length - 1 ? 1 : 0)
  }
  const bytes = await readRecord(store, 'fixture-session', 900)
  assert.equal(Buffer.from(bytes!).toString('utf8'), fixture('assistant-reasoning-fragmented').record)
  const activity = seatSummary(store).sessions[0]!
  assert.ok(Number(activity['reasoning_chars']) > 0, 'the reasoning text counts toward the Session')
})

test('a body that does not match its digest is refused and leaves nothing behind', async () => {
  const store = ready()
  const [record] = decode('header')
  const tampered = { ...record!, body: record!.body!.replace('session', 'sessioN') }
  await assert.rejects(commitRecords(store, seat, [tampered], 1000), (error: unknown) => error instanceof RecordRejected && error.code === 'DIGEST_MISMATCH' && error.status === 422)
  assert.equal(store.objects.size, 0)
  assert.equal(sessionRecords(store, 'fixture-session', -2, 10).length, 0)
})

test('a tampered final fragment is refused before the record completes', async () => {
  const store = ready()
  const parts = decode('assistant-reasoning-fragmented')
  for (const part of parts.slice(0, -1)) await commitRecords(store, seat, [part], 1000)
  const last = parts.at(-1)!
  const tampered = { ...last, body: Buffer.from(Buffer.from(last.body!, 'base64').toString('utf8').replace(/.$/, '!')).toString('base64') }
  await assert.rejects(commitRecords(store, seat, [tampered], 2000), (error: unknown) => error instanceof RecordRejected && error.code === 'DIGEST_MISMATCH')
  assert.equal(sessionRecords(store, 'fixture-session', -2, 10).length, 0)
})

test('records from another installation are refused', async () => {
  const store = ready()
  await assert.rejects(commitRecords(store, { ...seat, installation: 'seat-other' }, decode('header'), 1000),
    (error: unknown) => error instanceof RecordRejected && error.code === 'SOURCE_MISMATCH' && error.status === 403)
})

test('a seat stays bound to its first identity and refuses commits after revocation', async () => {
  const store = ready()
  await commitRecords(store, seat, decode('header'), 1000)
  await assert.rejects(commitRecords(store, { ...seat, student: 'seat-02' }, decode('assistant-reasoning'), 2000),
    (error: unknown) => error instanceof RecordRejected && error.code === 'IDENTITY_CONFLICT')
  assert.equal(revokeSeat(store, 'test', 3000), true)
  await assert.rejects(commitRecords(store, seat, decode('assistant-reasoning'), 4000),
    (error: unknown) => error instanceof RecordRejected && error.code === 'SEAT_REVOKED')
})

test('a sequence gap is recorded as a problem while the chain still advances', async () => {
  const store = ready()
  await commitRecords(store, seat, decode('header'), 1000)
  await commitRecords(store, seat, decode('assistant-reasoning'), 2000)
  const summary = seatSummary(store)
  assert.equal(summary.sessions[0]!['records'], 2)
  assert.equal(summary.problems.length, 1)
  assert.equal(summary.problems[0]!['code'], 'SEQUENCE_GAP')
})

test('a storage outage before the part row commits leaves the record replayable', async () => {
  const store = ready()
  store.failNextPut = true
  await assert.rejects(commitRecords(store, seat, decode('header'), 1000), /simulated storage outage/)
  const retry = await commitRecords(store, seat, decode('header'), 2000)
  assert.equal(retry.accepted, 1)
  assert.equal(sessionRecords(store, 'fixture-session', -2, 10).length, 1)
})
