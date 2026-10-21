import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { summarize } from '../src/activity.ts'

function recorded(name: string): { type: string, line: string }[] {
  return readFileSync(new URL(`../../../../snapshots/session/${name}/session.v4.jsonl`, import.meta.url), 'utf8')
    .split('\n').filter((line) => line.trim() !== '').map((line) => ({ type: (JSON.parse(line) as { type: string }).type, line }))
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
