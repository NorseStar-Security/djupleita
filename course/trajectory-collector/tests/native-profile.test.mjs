/** Built-profile checks for opt-in local collection; no model, external service, or student credentials. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateEnvironment } from '../native.mjs'

const repository = fileURLToPath(new URL('../../..', import.meta.url))
const bin = join(repository, 'apps/cli/lib/bin.js')
const launcher = join(repository, 'course/trajectory-collector/native.mjs')
const overlay = join(repository, 'course/trajectory-collector/native.overlay.yml')
const sessionId = 'native-collector-fixture'
const identity = { installationId: 'fixture-installation', studentId: 'fixture-student', cohortId: 'fixture-cohort' }
const built = path => join(repository, path, 'lib/index.js')
const moduleUrl = path => pathToFileURL(built(path)).href

function environment(root) {
  const inherited = Object.fromEntries(['PATH', 'TMPDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR']
    .flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  return {
    ...inherited, DSH_HOME: join(root, 'home'), DSH_TELEMETRY_MODE: 'DISABLED',
    COURSE_COLLECTOR_DB: join(root, 'collector', 'intake', 'collector.sqlite'),
    COURSE_PROJECTION_DB: join(root, 'collector', 'projection', 'projection.sqlite'),
    COURSE_INSTALLATION_ID: identity.installationId,
    COURSE_STUDENT_ID: identity.studentId,
    COURSE_COHORT_ID: identity.cohortId,
  }
}

async function sourceHashes(root) {
  const result = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.jsonl(?:\.zstd)?$/.test(entry.name)) continue
    const file = join(entry.parentPath, entry.name)
    result[relative(root, file)] = createHash('sha256').update(await readFile(file)).digest('hex')
  }
  return result
}

async function prepare(t) {
  for (const path of [bin, built('packages/experimental/trajectory-projection'), built('packages/experimental/trajectory-viewer')]) {
    await access(path).catch(() => { throw new Error('Build current host artifacts before running the native collector profile checks.') })
  }
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-collector-'))
  const stops = []
  t.after(async () => {
    const results = await Promise.allSettled(stops.map(stop => stop()))
    const failures = results.filter(result => result.status === 'rejected').map(result => result.reason)
    try { await rm(root, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Native collector fixture cleanup failed.')
  })
  const env = environment(root)
  const profile = join(env.DSH_HOME, 'profiles', 'collector-test')
  await mkdir(profile, { recursive: true, mode: 0o700 })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'course-native-collector-test', private: true, type: 'module', dsh: { profile: { bundles: [] } },
  }), { mode: 0o600 })
  const source = join(root, 'source')
  const { Context } = await import(moduleUrl('vendor/cordis'))
  const Jsonl = await import(moduleUrl('packages/session/session-persistence-jsonl'))
  const { SESSION_FORMAT_VERSION, SessionId, SessionSeq } = await import(moduleUrl('packages/core/session'))
  const ctx = new Context()
  let sourceContents
  try {
    await ctx.plugin(Jsonl, { root: source, compression: 'none' })
    const writer = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId(sessionId), createdAt: 1000, isSeeded: false,
    })
    try {
      await writer.append([
        { type: 'turn/start', seq: SessionSeq(0), time: 2000, data: { turn: 1 } },
        { type: 'turn/end', seq: SessionSeq(1), time: 2100, data: { turn: 1, reason: { kind: 'completed' } } },
      ])
    } finally { await writer.close() }
    const reader = await ctx.sessionPersistence.open(SessionId(sessionId), 'read')
    try {
      sourceContents = [JSON.stringify({ header: reader.header, inheritedEventCount: reader.inheritedEventCount }),
        ...(await reader.read()).events.map(event => JSON.stringify(event))]
    } finally { await reader.close() }
  } finally { await ctx.fiber.dispose() }
  const observer = join(root, 'observe.mjs')
  await writeFile(observer, `export const name = 'observe-native-collector-test'
export const inject = ['webServer', 'connection', 'trajectoryCollector', 'trajectoryProjection']
export function apply(ctx) {
  const origin = ctx.webServer.getOrigin()
  process.stdout.write('COLLECTOR_TEST_READY=' + JSON.stringify({origin, login: ctx.connection.authenticatedUrl(origin)}) + '\\n')
}
`, { mode: 0o600 })
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { name: built('vendor/logger-console') },
    { name: built('packages/credentials/credentials-local'), config: { watch: false } },
    { name: built('packages/host/webserver'), config: { host: '127.0.0.1', port: 0 } },
    { name: built('packages/client/connection') },
    { name: built('packages/session/session-persistence-jsonl'), config: { root: source, compression: 'none' } },
    { name: observer },
  ] }]), { mode: 0o600 })
  const rootRoute = join(root, 'root.patch.yml')
  // The fixture has no Web app index; the real HTTP plugin owns the launch-token exchange instead.
  await writeFile(rootRoute, JSON.stringify([{ id: 'course-trajectory-http', config: { serveRoot: true } }]), { mode: 0o600 })
  return { root, env, source, rootRoute, stops, sourceContents }
}

function start(t, fixture, extraArgs = [], changes = {}, shorthand = false) {
  let output = ''
  let timedOut = false
  let done = false
  const profile = shorthand ? ['collector-test'] : ['--profile', 'collector-test']
  const child = spawn(process.execPath, [launcher, ...profile, '--patch', fixture.rootRoute, ...extraArgs], {
    cwd: fixture.root, env: { ...fixture.env, ...changes }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let failure
  child.on('error', (error) => { failure = error })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-1024 * 1024) })
  const exited = new Promise(resolve => child.once('close', (code, signal) => { done = true; resolve({ code, signal }) }))
  const deadline = setTimeout(() => { timedOut = true; child.kill('SIGTERM') }, 35_000)
  const stop = async () => {
    if (!done) child.kill('SIGTERM')
    const grace = setTimeout(() => { if (!done) child.kill('SIGKILL') }, 20000)
    try { return await exited } finally { clearTimeout(grace); clearTimeout(deadline) }
  }
  fixture.stops.push(stop)
  const diagnostics = () => output.replace(/token=[^\s"'&]+/g, 'token=<redacted>')
  return {
    stop, exited, diagnostics,
    assertHealthy: () => { assert.equal(timedOut, false, 'The owned process deadline terminated the profile.'); assert.equal(failure, undefined) },
    waitReady: async () => {
      while (!done) {
        const line = output.match(/COLLECTOR_TEST_READY=(\{[^\n]+\})/)
        if (line) return JSON.parse(line[1])
        // Pacing only; readiness is established by the observer's injected services, not elapsed time.
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      throw new Error(`Collector profile exited before readiness:\n${diagnostics()}`)
    },
  }
}

async function request(origin, path, options = {}) {
  return fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(5000), redirect: 'manual' })
}

test('native overlay only inserts opt-in collection and viewer rows without replacing the app', async () => {
  const { loadOverlayPatches } = await import(moduleUrl('packages/boot/app-boot'))
  const patches = loadOverlayPatches('dsh', overlay)
  assert.equal(patches.length, 1)
  assert.deepEqual(Object.keys(patches[0]), ['insert'])
  const rows = patches[0].insert
  assert.deepEqual(rows.map(row => row.id), [
    'course-trajectory-collector', 'course-trajectory-archive', 'course-trajectory-projection',
    'course-trajectory-viewer', 'course-trajectory-http',
  ])
  assert.ok(rows.every(row => row.name.startsWith(pathToFileURL(join(repository, 'packages/experimental/')).href)))
  assert.equal(rows.find(row => row.id === 'course-trajectory-http').config.serveRoot, false)
  assert.equal(rows.find(row => row.id === 'course-trajectory-archive').config.copyAttachments, undefined)
})

test('native preflight requires explicit identity and separate archives outside the research home', () => {
  const valid = environment(join(tmpdir(), 'not-acquired-preflight-fixture'))
  assert.doesNotThrow(() => validateEnvironment(valid))
  for (const name of ['DSH_HOME', 'COURSE_COLLECTOR_DB', 'COURSE_PROJECTION_DB', 'COURSE_INSTALLATION_ID', 'COURSE_STUDENT_ID', 'COURSE_COHORT_ID']) {
    assert.throws(() => validateEnvironment({ ...valid, [name]: undefined }), new RegExp(name))
  }
  assert.throws(() => validateEnvironment({ ...valid, COURSE_STUDENT_ID: 'é'.repeat(65) }), /128 UTF-8 bytes/)
  assert.throws(() => validateEnvironment({ ...valid, COURSE_STUDENT_ID: 'label\nunsafe' }), /control characters/)
  assert.throws(() => validateEnvironment({ ...valid, COURSE_COHORT_ID: '  ' }), /instructor-assigned/)
  assert.throws(() => validateEnvironment({ ...valid, DSH_HOME: 'relative/home' }), /absolute/)
  assert.throws(() => validateEnvironment({ ...valid, COURSE_COLLECTOR_DB: join(valid.DSH_HOME, 'archive', 'collector.sqlite') }), /outside DSH_HOME/)
  assert.throws(() => validateEnvironment({ ...valid, COURSE_PROJECTION_DB: join(valid.DSH_HOME, 'projection.sqlite') }), /outside DSH_HOME/)
  assert.throws(() => validateEnvironment({ ...valid, COURSE_PROJECTION_DB: valid.COURSE_COLLECTOR_DB }), /separate/)
})

test('built native overlay collects unchanged source records, authenticates inspection, and replays after restart', { timeout: 60_000 }, async (t) => {
  const fixture = await prepare(t)
  const before = await sourceHashes(fixture.source)
  let projectionId
  let traceId
  for (let attempt = 0; attempt < 2; attempt++) {
    const running = start(t, fixture, [], {}, attempt === 1)
    const { origin, login } = await running.waitReady()
    assert.equal((await request(origin, '/api/trajectory/status')).status, 401)
    assert.equal((await request(origin, '/api/trajectory-viewer/status')).status, 401)
    const exchanged = await fetch(login, { signal: AbortSignal.timeout(5000), redirect: 'manual' })
    const cookie = exchanged.headers.get('set-cookie')?.split(';', 1)[0]
    assert.ok(cookie, 'Instructor launch-token exchange must issue a cookie.')
    let status
    while (status?.records !== 3) {
      const response = await request(origin, '/api/trajectory/status', { headers: { cookie } })
      assert.equal(response.status, 200)
      status = await response.json()
      if (status.records !== 3) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(status.lastCursor, 3)
    const response = await request(origin, '/api/trajectory/records', { headers: { cookie } })
    assert.equal(response.status, 200)
    const page = await response.json()
    assert.deepEqual(page.records.map(row => row.sequence), [-1, 0, 1])
    assert.ok(page.records.every(row => row.sessionId === sessionId && JSON.stringify(row.identity) === JSON.stringify(identity)))
    assert.deepEqual(page.records.map(row => row.content), fixture.sourceContents)
    assert.deepEqual(page.records.map(row => row.sha256), fixture.sourceContents.map(content => createHash('sha256').update(content).digest('hex')))
    let viewerStatus
    while (viewerStatus?.projection.collectorCursor !== 3) {
      const response = await request(origin, '/api/trajectory-viewer/status', { headers: { cookie } })
      assert.equal(response.status, 200)
      viewerStatus = await response.json()
      assert.notEqual(viewerStatus.projection.state, 'failed', 'The projection must index the complete archived fixture.')
      if (viewerStatus.projection.collectorCursor !== 3) await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(viewerStatus.collector.records, 3)
    assert.equal(viewerStatus.projection.traces, 1)
    if (attempt === 0) projectionId = viewerStatus.projection.projectionId
    else assert.equal(viewerStatus.projection.projectionId, projectionId, 'Restart must retain the same durable read model.')
    const tracesResponse = await request(origin, '/api/trajectory-viewer/traces', { headers: { cookie } })
    assert.equal(tracesResponse.status, 200)
    const traces = await tracesResponse.json()
    assert.equal(traces.traces.length, 1)
    assert.equal(traces.traces[0].status, 'completed')
    assert.equal(traces.traces[0].sessionId, sessionId)
    if (attempt === 0) traceId = traces.traces[0].traceId
    else assert.equal(traces.traces[0].traceId, traceId)
    const detailResponse = await request(origin, `/api/trajectory-viewer/detail?traceId=${traceId}`, { headers: { cookie } })
    assert.equal(detailResponse.status, 200)
    const detail = await detailResponse.json()
    assert.equal(detail.trace.traceId, traceId)
    assert.ok(detail.spans.some(span => span.kind === 'turn' && span.status === 'completed'))
    const viewerSource = await request(origin, '/api/trajectory-viewer/records', { headers: { cookie } })
    assert.equal(viewerSource.status, 200)
    assert.deepEqual(await viewerSource.json(), page, 'The GUI source route must return the exact committed collector page.')
    assert.equal((await request(origin, '/api/trajectory-viewer/traces?limit=101', { headers: { cookie } })).status, 400)
    assert.equal((await request(origin, '/api/trajectory-viewer/records', { method: 'POST', headers: { cookie } })).status, 405)
    assert.equal((await request(origin, '/api/trajectory/records', { method: 'POST', body: '{}', headers: { cookie, 'content-type': 'application/json' } })).status, 503)
    const result = await running.stop()
    running.assertHealthy()
    assert.equal(result.code, 0, running.diagnostics())
    assert.equal(result.signal, null, 'Graceful disposal should complete without a termination signal.')
  }
  assert.deepEqual(await sourceHashes(fixture.source), before)
})

test('native launcher rejects missing trusted identity before starting the CLI', { timeout: 60_000 }, async (t) => {
  const fixture = await prepare(t)
  const running = start(t, fixture, [], { COURSE_STUDENT_ID: undefined })
  const result = await running.exited
  running.assertHealthy()
  assert.notEqual(result.code, 0, 'A missing trusted student label must fail startup.')
  assert.equal(result.signal, null)
  assert.match(running.diagnostics(), /COURSE_STUDENT_ID/)
  assert.doesNotMatch(running.diagnostics(), /COLLECTOR_TEST_READY/)
})


test('native runtime pulls Protected records with colliding session IDs and deduplicates restart replay', { timeout: 60_000 }, async t => {
  const fixture = await prepare(t)
  const records = fixture.sourceContents.map((content, index) => {
    const value = JSON.parse(content)
    return { sessionId, sequence: index - 1, content, type: index === 0 ? 'session/header' : value.type,
      timestamp: index === 0 ? value.header.createdAt : value.time }
  })
  const relay = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture.invalid')
    if (url.pathname === '/' && url.searchParams.get('token') === 'fixture-research-token') {
      res.writeHead(303, { 'set-cookie': 'research=fixture; HttpOnly; SameSite=Strict' }); res.end(); return
    }
    assert.equal(req.headers.cookie, 'research=fixture', 'Only the separate research credential may reach the relay.')
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/course-runtime/activity') { res.end('[]'); return }
    if (url.pathname !== '/course-runtime/archive') { res.writeHead(404); res.end('{}'); return }
    if (!url.searchParams.has('sessionId')) { res.end(JSON.stringify({ sessions: [sessionId] })); return }
    const after = Number(url.searchParams.get('after'))
    res.end(JSON.stringify({ records: records.filter(record => record.sequence >= after), next: 2 }))
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  fixture.stops.push(() => new Promise((resolve, reject) => relay.close(error => error ? reject(error) : resolve())))
  const state = join(fixture.root, 'runtime-state')
  await mkdir(state)
  await writeFile(join(state, 'backend.json'), JSON.stringify({ origin: `http://127.0.0.1:${relay.address().port}`, token: 'fixture-research-token' }))
  // Replace only the external VM lifecycle executable. HTTP authentication, Loader, config ownership and storage stay real.
  const python = join(fixture.root, 'vm-fixture.py')
  await writeFile(python, '#!/usr/bin/env python3\nimport json,sys\nif sys.argv[2] == "status": print(json.dumps({"phase":"running","healthy":True,"prepared":True}))\n', { mode: 0o700 })
  const profile = join(fixture.env.DSH_HOME, 'profiles/collector-test/cordis.patch.yml')
  const rows = JSON.parse(await readFile(profile, 'utf8'))
  rows[0].insert.push(
    { name: built('packages/boot/config-editor') },
    { id: 'course-runtime', name: built('packages/experimental/course-runtime'), config: {
      role: 'instructor', sourceRoot: repository, stateRoot: state, python, archivePollIntervalMs: 1000,
    } },
  )
  await writeFile(profile, JSON.stringify(rows))
  for (let attempt = 0; attempt < 2; attempt++) {
    const running = start(t, fixture)
    const { origin, login } = await running.waitReady()
    const exchanged = await fetch(login, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
    const cookie = exchanged.headers.get('set-cookie').split(';', 1)[0]
    let status
    const deadline = Date.now() + 15000
    do {
      status = await (await request(origin, '/api/trajectory-viewer/status', { headers: { cookie } })).json()
      if (status.collector.records === 6 && status.projection.collectorCursor === 6) break
      assert.ok(Date.now() < deadline, 'Both Local and Protected records must be collected and indexed.')
      await new Promise(resolve => setTimeout(resolve, 20))
    } while (true)
    const page = await (await request(origin, '/api/trajectory-viewer/records', { headers: { cookie } })).json()
    assert.equal(page.records.length, 6)
    const protectedRecords = page.records.filter(row => row.identity.installationId !== identity.installationId)
    assert.deepEqual(protectedRecords.map(row => row.content), fixture.sourceContents)
    assert.ok(protectedRecords.every(row => row.sessionId === sessionId && row.identity.installationId.startsWith('protected-')))
    const traces = await (await request(origin, '/api/trajectory-viewer/traces', { headers: { cookie } })).json()
    assert.equal(traces.traces.length, 2, 'The same session ID on two runtimes must retain two trace identities.')
    const runtime = await (await request(origin, '/course-runtime/status', { headers: { cookie } })).json()
    assert.equal(runtime.trajectoryError, undefined)
    assert.equal((await running.stop()).code, 0, running.diagnostics())
    running.assertHealthy()
  }
})
