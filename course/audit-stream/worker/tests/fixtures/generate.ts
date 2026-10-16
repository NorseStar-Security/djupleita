/**
 * Regenerate `otlp-requests.json` from the shipped exporter encoder and a recorded Session.
 *
 * Run from the repository root after `pnpm install`:
 *   node --import tsx/esm course/audit-stream/worker/tests/fixtures/generate.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TrajectoryEncoder } from '../../../../../packages/experimental/trajectory-export-otlp/src/encoding.ts'

const here = fileURLToPath(new URL('.', import.meta.url))
const session = readFileSync(new URL('../../../../../snapshots/session/deepseek-messages-replay/session.v4.jsonl', import.meta.url), 'utf8')
  .split('\n').filter((line) => line.trim() !== '')

const encoder = new TrajectoryEncoder()
const sourceId = 'seat-fixture'
const sessionId = 'fixture-session'
const cases = [
  { name: 'header', seq: -1, line: session[0]!, fragmentBytes: 64 * 1024 },
  { name: 'assistant-reasoning', seq: session.findIndex((line) => line.includes('"type":"assistant/message"')) - 1, line: session.find((line) => line.includes('"type":"assistant/message"'))!, fragmentBytes: 64 * 1024 },
  { name: 'assistant-reasoning-fragmented', seq: 900, line: session.find((line) => line.includes('"type":"assistant/message"'))!, fragmentBytes: 256 },
]
const out = cases.map(({ name, seq, line, fragmentBytes }) => {
  const type = (JSON.parse(line) as { type: string }).type
  const requests = [...encoder.encode(line, { sourceId, sessionId, sequence: seq, type, timestamp: 1_792_200_000_000 }, fragmentBytes, 1024 * 1024)]
  return { name, sourceId, sessionId, seq, type, fragmentBytes, record: line, requests: requests.map((bytes) => Buffer.from(bytes).toString('base64')) }
})
await encoder.close()
writeFileSync(`${here}otlp-requests.json`, `${JSON.stringify({ generatedBy: 'packages/experimental/trajectory-export-otlp/src/encoding.ts', cases: out }, null, 2)}\n`)
