/** Run pinned passive CLIs against private source API fixtures, then use the production JSONL normalizer. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { argumentsFor, observationsFrom } from '../../../packages/experimental/recon-projectdiscovery/src/components.ts'
import { TargetScope } from '../../../packages/experimental/recon-projectdiscovery/src/scope.ts'

const directory = fileURLToPath(new URL('.', import.meta.url))
const policy = {
  domains: ['example.test', '*.example.test'], ips: [], exclude_domains: ['blocked.example.test'],
  infrastructure: {
    'crt.sh': { methods: ['GET'], paths: ['/'] },
    'web.archive.org': { methods: ['GET'], paths: ['/cdx/search/cdx'] },
  },
}
const scope = new TargetScope(policy)
const before = JSON.stringify(policy)
const cases = ['subfinder', 'urlfinder'].map(component => ({
  name: component,
  args: argumentsFor(component, ['example.test'], {
    proxy: 'http://127.0.0.1:18081', resolver: '127.0.0.1:15353', rate: 5, concurrency: 2, depth: 2,
    ports: [18080], home: '/tmp/passive-smoke-config', sources: { subfinder: ['crtsh'], urlfinder: ['waybackarchive'] }, responseMaxBytes: 1048576,
  }),
}))

async function docker(args, input, timeoutMs, signal) {
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  let bytes = 0
  let timedOut = false
  let aborted = false
  let overflow = false
  let escalation
  const stop = () => {
    child.kill('SIGTERM')
    escalation ??= setTimeout(() => { child.kill('SIGKILL') }, 5000)
  }
  const abort = () => { aborted = true; stop() }
  const deadline = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  signal?.addEventListener('abort', abort, { once: true })
  const collect = target => chunk => {
    bytes += chunk.length
    if (bytes > 1048576) { overflow = true; stop() }
    else target.push(chunk)
  }
  child.stdout.on('data', collect(stdout))
  child.stderr.on('data', collect(stderr))
  child.stdin.on('error', error => {
    // A rejected Docker launch can close stdin before the fixture input is accepted; its exit reports the failure.
    if (error.code !== 'EPIPE') stop()
  })
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, exitSignal) => { resolve({ code, signal: exitSignal }) })
  })
  child.stdin.end(input)
  if (signal?.aborted) abort()
  try {
    const result = await completion
    assert(!timedOut, `Docker ${args[0]} timed out`)
    assert(!aborted, `Docker ${args[0]} was cancelled`)
    assert(!overflow, `Docker ${args[0]} exceeded the output budget`)
    assert.equal(result.signal, null, `Docker ${args[0]} must not be killed`)
    assert.equal(result.code, 0, `Docker ${args[0]} failed: ${Buffer.concat(stderr).toString('utf8')}`)
    return Buffer.concat(stdout).toString('utf8')
  } finally {
    clearTimeout(deadline)
    clearTimeout(escalation)
    signal?.removeEventListener('abort', abort)
  }
}

const container = `dsh-passive-smoke-${randomUUID()}`
const cancellation = new AbortController()
const abort = () => { cancellation.abort() }
process.on('SIGINT', abort)
process.on('SIGTERM', abort)
try {
  const output = await docker([
    'run', '--rm', '--name', container, '-i', '--network', 'none', '--cap-drop', 'ALL', '--user', '1000:1000',
    // The SQL-first crtsh adapter must fail locally before its HTTP fallback; no external DNS or PostgreSQL is contacted.
    '--add-host', 'crt.sh:127.0.0.1', '-v', `${directory}:/checks:ro`,
    '--entrypoint', 'python3', 'dsh-course-recon-tools', '/checks/passive_cli_fixture.py',
  ], JSON.stringify(cases), 240000, cancellation.signal)
  const results = JSON.parse(output)
  for (const result of results) {
    const observations = observationsFrom(result.stdout, result.name, scope, 20)
    assert.equal(observations.length, 2)
    assert(observations.some(item => item.inScope && item.value.includes('api.example.test')))
    assert(observations.some(item => !item.inScope && item.value.includes('blocked.example.test')))
    assert(!scope.allows('blocked.example.test'), 'a discovered excluded host must remain excluded')
    assert(!scope.allows('crt.sh'), 'operational API access must not authorize recon targets')
    assert(!scope.allows('web.archive.org'), 'operational API access must not authorize recon targets')
    assert.deepEqual(observationsFrom(result.failureStdout, result.name, scope, 20), [])
    console.log(`${result.name}: source API routing, JSONL normalization, exclusions, empty-on-source-error, and cancellation PASS; source-error diagnostics present: ${result.failureDiagnosticsPresent}`)
  }
  assert.equal(JSON.stringify(policy), before, 'discovery must never mutate the target policy')
} finally {
  try {
    // The random exact-name filter can match only this run's container, including after an interrupted Docker client.
    const remaining = (await docker(['container', 'ls', '--all', '--quiet', '--filter', `name=^/${container}$`], '', 10000)).trim()
    if (remaining) {
      assert.match(remaining, /^[a-f0-9]{12,64}$/)
      await docker(['container', 'rm', '--force', remaining], '', 10000)
    }
  } finally {
    process.off('SIGINT', abort)
    process.off('SIGTERM', abort)
  }
}
