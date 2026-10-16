import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeLogsJson, decodeLogsProtobuf, OtlpDecodeError } from '../src/otlp.ts'
import { bytesOf, fixture } from './helpers.ts'

test('exporter protobuf requests decode to the exact record and its attributes', () => {
  const header = fixture('header')
  const records = decodeLogsProtobuf(bytesOf(header.requests[0]!))
  assert.equal(records.length, 1)
  const [record] = records
  assert.equal(record!.body, header.record)
  assert.equal(record!.eventName, 'dsh.trajectory.record')
  assert.equal(record!.timeUnixNano, '1792200000000000000')
  assert.equal(record!.attributes['dsh.event.seq'], -1)
  assert.equal(record!.attributes['dsh.trajectory.schema'], 1)
  assert.equal(record!.attributes['dsh.source.id'], 'seat-fixture')
  assert.equal(record!.attributes['dsh.record.encoding'], 'json')
  assert.equal(record!.attributes['dsh.record.parts'], 1)
})

test('fragment requests carry ordered base64 parts that rebuild the record', () => {
  const fragmented = fixture('assistant-reasoning-fragmented')
  const parts = fragmented.requests.map((request) => decodeLogsProtobuf(bytesOf(request))[0]!)
  assert.equal(parts.length, 10)
  parts.forEach((part, index) => {
    assert.equal(part.eventName, 'dsh.trajectory.fragment')
    assert.equal(part.attributes['dsh.record.part'], index)
    assert.equal(part.attributes['dsh.record.parts'], 10)
    assert.equal(part.attributes['dsh.record.encoding'], 'base64-json-utf8')
  })
  const rebuilt = Buffer.concat(parts.map((part) => Buffer.from(part.body!, 'base64'))).toString('utf8')
  assert.equal(rebuilt, fragmented.record)
})

test('truncated protobuf input is rejected rather than partially read', () => {
  const bytes = bytesOf(fixture('header').requests[0]!)
  assert.throws(() => decodeLogsProtobuf(bytes.subarray(0, bytes.length - 7)), OtlpDecodeError)
})

test('an empty protobuf request holds no records', () => {
  assert.deepEqual(decodeLogsProtobuf(new Uint8Array()), [])
})

test('OTLP JSON requests decode string, integer, and string-encoded int64 attributes', () => {
  const records = decodeLogsJson(JSON.stringify({
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: '1792200000000000000',
          eventName: 'dsh.trajectory.record',
          body: { stringValue: '{"type":"turn/start"}' },
          attributes: [
            { key: 'dsh.event.seq', value: { intValue: '-1' } },
            { key: 'dsh.record.parts', value: { intValue: 1 } },
            { key: 'dsh.source.id', value: { stringValue: 'seat-a' } },
          ],
        }],
      }],
    }],
  }))
  assert.equal(records.length, 1)
  assert.equal(records[0]!.attributes['dsh.event.seq'], -1)
  assert.equal(records[0]!.attributes['dsh.record.parts'], 1)
  assert.equal(records[0]!.body, '{"type":"turn/start"}')
})

test('OTLP JSON with the wrong structure is rejected', () => {
  assert.throws(() => decodeLogsJson('{"resourceLogs": {}}'), OtlpDecodeError)
  assert.throws(() => decodeLogsJson('not json'), OtlpDecodeError)
})
