import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestHarness, provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LinuxActionReview from '@deepseek-ai/dsh-experimental-action-review-linux'
import LinuxNetworkScope from '@deepseek-ai/dsh-experimental-network-scope-linux'
import LlmRuntime, { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import * as Guard from '../src/index.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'Python gateway fixture cleanup failed')
})

// Only the evaluator is deterministic. The Python policy, Engine, SQLite
// commits, Unix HTTP handler and TypeScript admission pipeline are production code.
const pythonFixture = String.raw`
import json
from pathlib import Path
import sqlite3
import sys
import threading

sys.path.insert(0, sys.argv[1])
from action_review import Engine, Registry
from control import ControlServer, Journal
from policy import Policy

root, socket_path = Path(sys.argv[2]), Path(sys.argv[3])
database = root / "receipts.sqlite3"
policy_json = {"domains": ["acme.test"]}
policy = Policy(policy_json)
config = json.loads((Path(sys.argv[1]) / "review.json").read_text())
config["evaluators"] = [{"id": "fixture", "kind": "fixture", "endpoint": "https://never-contact.invalid/", "model": "fixture-v1", "credentialRef": ""}]
registry = Registry()

def evaluate(_config, state, rubrics, _credential, _deadline, _maximum, _transport):
    assert state["networkPolicy"] == policy_json
    with sqlite3.connect(database) as connection:
        assert connection.execute("SELECT decision,code FROM decisions ORDER BY receipt DESC LIMIT 1").fetchone() == ("deny", "ACTION_REVIEW_PENDING")
    command = state["action"]["arguments"]["command"]
    if command == "evaluator-error":
        raise RuntimeError("deterministic evaluator failure")
    if command == "audit-unavailable":
        # The request is committed in the original DB; opening this existing
        # private directory as a SQLite database makes the final commit fail.
        engine.database = root
    risks = {rubric["id"]: 0.0 for rubric in rubrics}
    if command == "shutdown-service":
        risks["destructive"] = 1.0
    return "fixture-v1", risks

registry.add("fixture", evaluate)
journal = Journal(policy, policy_json)
engine = Engine(config, policy, journal.instance, {}, database, network_policy=policy_json, registry=registry)
server = ControlServer(socket_path, journal, lambda: True, engine)
server.daemon_threads = False
worker = threading.Thread(target=server.serve_forever)
worker.start()
print("ready", flush=True)
try:
    command = sys.stdin.readline()
    if command not in ("", "stop\n"):
        raise ValueError("unexpected fixture shutdown command")
finally:
    server.shutdown()
    server.server_close()
    worker.join(timeout=10)
    if worker.is_alive():
        raise RuntimeError("control server did not stop")
print("stopped", flush=True)
`

async function startGateway(root: string, socketPath: string): Promise<void> {
  const source = fileURLToPath(new URL('../../../../course/scope-runtime/', import.meta.url))
  // No inherited model keys or instrumentation settings reach this trusted fixture.
  const child = spawn('python3', ['-u', '-c', pythonFixture, source, root, socketPath], {
    stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' },
  })
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  let stdout = '', stderr = '', expired = false, forced = false
  const failures: unknown[] = []
  let resolveReady: () => void = () => {}
  let rejectReady: (error: Error) => void = () => {}
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const collect = (channel: 'stdout' | 'stderr', chunk: Buffer): void => {
    if (channel === 'stdout') stdout += chunk.toString('utf8')
    else stderr += chunk.toString('utf8')
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 65536) {
      failures.push(new Error('Python gateway fixture output exceeded its budget'))
      child.kill('SIGKILL')
      rejectReady(new Error('Python gateway fixture output exceeded its budget'))
    }
    if (stdout.split('\n').includes('ready')) resolveReady()
  }
  child.stdout.on('data', (chunk: Buffer) => { collect('stdout', chunk) })
  child.stderr.on('data', (chunk: Buffer) => { collect('stderr', chunk) })
  child.once('error', (error) => { failures.push(error); rejectReady(error) })
  child.stdin.on('error', (error) => { failures.push(error) })
  const deadline = setTimeout(() => { expired = true; child.kill('SIGKILL') }, 30_000)
  deadline.unref()
  cleanups.push(async () => {
    child.stdin.end('stop\n')
    const force = setTimeout(() => { forced = true; child.kill('SIGKILL') }, 10_000)
    force.unref()
    try {
      const outcome = await closed
      expect({ expired, forced, ...outcome, failures, stderr }).toEqual({ expired: false, forced: false, code: 0, signal: null, failures: [], stderr: '' })
      expect(stdout.split('\n')).toContain('stopped')
    } finally {
      clearTimeout(force)
      clearTimeout(deadline)
    }
  })
  await Promise.race([ready, closed.then((outcome) => { throw new Error(`Python gateway exited before readiness: ${JSON.stringify(outcome)} ${stderr}`) })])
}

function receipts(path: string) {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return database.prepare('SELECT receipt,decision,code,input_hash,action FROM decisions ORDER BY receipt').all().map((row) => {
      if (typeof row.receipt !== 'number' || typeof row.decision !== 'string' || typeof row.code !== 'string'
        || typeof row.input_hash !== 'string' || typeof row.action !== 'string') throw new Error('Unexpected durable receipt fields')
      return { receipt: row.receipt, decision: row.decision, code: row.code, inputHash: row.input_hash, action: row.action }
    })
  } finally { database.close() }
}

describe.skipIf(process.platform === 'win32')('real Python gateway and mandatory TypeScript admission', () => {
  it('executes only after a committed allow and denies destructive, failed and unavailable reviews', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-review-py-'))
    cleanups.push(() => rm(root, { recursive: true, force: true }))
    const socketPath = join(root, 'g.sock')
    await startGateway(root, socketPath)
    const ctx = new Context()
    cleanups.push(() => ctx.fiber.dispose())
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, tools: ToolRuntime, sessions: SessionStore, prompt: SystemPrompt,
      'scope-linux': LinuxNetworkScope, 'review-linux': LinuxActionReview, 'review-guard': Guard })
    const path = join(root, 'cordis.yml')
    await writeFile(path, ['- name: cordis:prompt', '- name: cordis:tools', '- name: cordis:sessions',
      '- name: cordis:scope-linux', '  config:', `    socketPath: ${JSON.stringify(socketPath)}`,
      '- name: cordis:review-linux', '  config:', `    socketPath: ${JSON.stringify(socketPath)}`,
      '- name: cordis:review-guard', ''].join('\n'))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(path).href } })
    await ctx.loader.await()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjections)
    await ctx.plugin(AgentRegistry)
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(SessionId('python-research'), {}, { cwd: root })
    const database = join(root, 'receipts.sqlite3')
    const effects: { arguments: unknown; receipt: number }[] = []
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'terminal', description: 'Deterministic research capability.',
      parameters: { command: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args) {
        const committed = receipts(database).at(-1)
        if (committed?.decision !== 'allow' || committed.code !== 'ACTION_REVIEW_ALLOWED') throw new Error('Tool body preceded durable allow')
        effects.push({ arguments: args, receipt: committed.receipt })
        return 'fixture completed'
      },
    })))
    let call = 0
    const run = (command: string) => ctx.tools.execute({ name: 'terminal', arguments: { command }, callId: ToolCallId(`python-call-${++call}`),
      agent, signal: new AbortController().signal })

    const safe = { command: 'read-only research 界' }
    expect((await run(safe.command)).isError).toBe(false)
    expect(effects).toEqual([{ arguments: safe, receipt: 1 }])
    expect((await run('shutdown-service')).isError).toBe(true)
    expect((await run('evaluator-error')).isError).toBe(true)
    expect(effects).toHaveLength(1)
    const beforeFailure = receipts(database)
    expect(beforeFailure.map(row => [row.receipt, row.decision, row.code])).toEqual([
      [1, 'allow', 'ACTION_REVIEW_ALLOWED'], [2, 'deny', 'ACTION_RISK_DENIED'], [3, 'deny', 'ACTION_REVIEW_FAILED'],
    ])
    expect(JSON.parse(beforeFailure[0]!.action)).toMatchObject({ tool: 'terminal', sessionId: 'python-research', arguments: safe,
      schema: { name: 'terminal', description: 'Deterministic research capability.' } })
    const decisions = () => agent.session.snapshotEvents().map(pluginRecordOf)
      .filter(record => record?.type === 'plugin:action-review-guard/decision')
    expect(decisions().map(record => record?.data)).toMatchObject(beforeFailure.map(row => ({ code: row.code,
      allowed: row.decision === 'allow', review: { receipt: row.receipt, inputHash: row.inputHash } })))

    expect((await run('audit-unavailable')).isError).toBe(true)
    expect(receipts(database).map(row => [row.receipt, row.decision, row.code])).toEqual([
      [1, 'allow', 'ACTION_REVIEW_ALLOWED'], [2, 'deny', 'ACTION_RISK_DENIED'], [3, 'deny', 'ACTION_REVIEW_FAILED'],
      [4, 'deny', 'ACTION_REVIEW_PENDING'],
    ])
    expect((await run(safe.command)).isError).toBe(true)
    expect(receipts(database)).toHaveLength(4)
    expect(effects).toEqual([{ arguments: safe, receipt: 1 }])
    expect(decisions().slice(-2).map(record => record?.data)).toMatchObject([
      { allowed: false, code: 'ACTION_REVIEW_UNAVAILABLE' }, { allowed: false, code: 'ACTION_REVIEW_UNAVAILABLE' },
    ])
    expect((await ctx.actionReview.status(new AbortController().signal)).ready).toBe(false)
  })
})
