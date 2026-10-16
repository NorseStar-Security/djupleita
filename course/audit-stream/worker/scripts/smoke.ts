/**
 * Verify a deployed receiver with the exporter-encoded fixtures.
 *
 *   NS_AUDIT_URL=https://<worker host> NS_AUDIT_SEAT_TOKEN=<seat> NS_AUDIT_BOARD_TOKEN=<board> node scripts/smoke.ts
 *
 * The seat token must name installation `seat-fixture`; use a dedicated smoke cohort, because
 * stored records are immutable. Exits 1 when any check fails.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

interface FixtureCase { name: string, sessionId: string, seq: number, record: string, requests: string[] }

const url = process.env['NS_AUDIT_URL']?.replace(/\/$/, '')
const seatToken = process.env['NS_AUDIT_SEAT_TOKEN']
const boardToken = process.env['NS_AUDIT_BOARD_TOKEN']
if (url === undefined || seatToken === undefined || boardToken === undefined) {
  throw new Error('set NS_AUDIT_URL, NS_AUDIT_SEAT_TOKEN, and NS_AUDIT_BOARD_TOKEN')
}
const { cases } = JSON.parse(readFileSync(new URL('../tests/fixtures/otlp-requests.json', import.meta.url), 'utf8')) as { cases: FixtureCase[] }
let failures = 0

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === '' ? '' : ` (${detail})`}\n`)
}

async function upload(body: BodyInit, type: string): Promise<number> {
  const response = await fetch(`${url}/v1/logs`, { method: 'POST', headers: { authorization: `Bearer ${seatToken}`, 'content-type': type }, body })
  await response.arrayBuffer()
  return response.status
}

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function jsonRequest(source: string, seq: number, body: string, digest: string): string {
  const attributes = Object.entries({
    'dsh.trajectory.schema': 1, 'dsh.source.id': source, 'dsh.session.id': 'smoke-json', 'dsh.event.seq': seq, 'dsh.event.type': 'turn/start',
    'dsh.record.id': sha256(`smoke-${seq}`), 'dsh.record.sha256': digest, 'dsh.record.encoding': 'json', 'dsh.record.part': 0, 'dsh.record.parts': 1,
  }).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: value } }))
  return JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ body: { stringValue: body }, attributes }] }] }] })
}

for (const entry of cases) {
  const statuses = []
  for (const request of entry.requests) statuses.push(await upload(Buffer.from(request, 'base64'), 'application/x-protobuf'))
  check(`upload ${entry.name} (${entry.requests.length} requests)`, statuses.every((status) => status === 200), statuses.join(','))
}
check('replayed header is acknowledged', await upload(Buffer.from(cases[0]!.requests[0]!, 'base64'), 'application/x-protobuf') === 200)
check('body that contradicts its digest is refused', await upload(jsonRequest('seat-fixture', 5, '{"type":"turn/start"}', sha256('{"type":"turn/end"}')), 'application/json') === 422)
check('record from another installation is refused', await upload(jsonRequest('another-seat', 6, '{}', sha256('{}')), 'application/json') === 403)

const read = async (path: string): Promise<Response> => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${boardToken}` } })
const seat = await (await read('/api/seat?installation=seat-fixture')).json() as { sessions: { session_id: string, records: number }[] }
const session = seat.sessions.find((row) => row.session_id === 'fixture-session')
check('seat index lists the fixture Session', session !== undefined && session.records >= cases.length, `records=${session?.records}`)
for (const entry of cases) {
  const response = await read(`/api/raw?installation=seat-fixture&session=${entry.sessionId}&seq=${entry.seq}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  check(`stored bytes of ${entry.name} match the exporter record`, response.status === 200 && sha256(bytes) === sha256(entry.record))
}
process.exitCode = failures === 0 ? 0 : 1
