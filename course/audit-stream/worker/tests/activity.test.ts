import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { summarize } from '../src/activity.ts'

function recorded(name: string): { type: string, line: string }[] {
  if (name === 'deepseek-messages-replay') {
    const source = JSON.parse(readFileSync(new URL('./fixtures/otlp-requests.json', import.meta.url), 'utf8')) as { cases: { type: string, record: string }[] }
    return source.cases.map(entry => ({ type: entry.type, line: entry.record }))
  }
  // These receiver-owned records exercise the v4 fields without depending on a harness checkout.
  const events = [
    { type: 'tool/call', data: { name: 'http_request', arguments: '{}' } },
    { type: 'plugin:network-scope-guard/judge', data: { allowed: false, tool: 'http_request', code: 'OUT_OF_SCOPE' } },
    { type: 'plugin:network-scope-guard/judge', data: { allowed: true, tool: 'http_request', code: 'IN_SCOPE' } },
    { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
    { type: 'session/title', data: { title: 'Receiver fixture' } },
  ]
  return events.map(event => ({ type: event.type, line: JSON.stringify(event) }))
}

test('assistant messages report reasoning length and a reasoning preview', () => {
  const message = recorded('deepseek-messages-replay').find((entry) => entry.type === 'assistant/message')!
  const summary = summarize(message.type, message.line)
  assert.ok(summary.reasoningChars > 0)
  assert.ok(summary.reasoning.length > 0)
  assert.match(summary.text, /^assistant: thought \d+ chars/)
})

test('scope judge records count denials and tool calls count calls', () => {
  const entries = recorded('network-scope')
  const totals = entries.map((entry) => summarize(entry.type, entry.line))
    .reduce((sum, summary) => ({ calls: sum.calls + summary.toolCalls, denials: sum.denials + summary.scopeDenials }), { calls: 0, denials: 0 })
  assert.equal(totals.calls, entries.filter((entry) => entry.type === 'tool/call').length)
  const denied = entries.filter((entry) => entry.type === 'plugin:network-scope-guard/judge' && (JSON.parse(entry.line) as { data: { allowed: boolean } }).data.allowed === false).length
  assert.equal(totals.denials, denied)
})

test('the request model and Session title surface for the board', () => {
  const entries = recorded('network-scope')
  const context = entries.find((entry) => entry.type === 'request/context')!
  assert.equal(summarize(context.type, context.line).model, 'deepseek-official/deepseek-v4-flash')
  const title = entries.find((entry) => entry.type === 'session/title')!
  assert.ok(summarize(title.type, title.line).title)
})

test('unknown types and unreadable bodies summarize to their type', () => {
  assert.equal(summarize('plugin:future/kind', '{}').text, 'plugin:future/kind')
  assert.equal(summarize('turn/start', 'not json').text, 'turn/start')
})
