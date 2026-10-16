import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveExampleLaunch, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { cleanups, fixture } from './harness.ts'
import { decodeSpans } from './trace-protocol.ts'

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'remote profile fixture cleanup failed')
})

it('runs the built remote opt-in local profile with complete logs and separately acknowledged real traces',
  { timeout: LOADER_SMOKE_TEST_TIMEOUT_MS, retry: 0 }, async () => {
    const f = await fixture()
    type RecordedMessageId = Extract<SessionEvent, { type: 'assistant/message' }>['data']['message']['id']
    const canonical: SessionEvent[] = [
      { seq: SessionSeq(0), time: 1000, type: 'turn/start', data: { turn: 1 } },
      { seq: SessionSeq(1), time: 1001, type: 'step/start', data: { turn: 1, step: 1 } },
      { seq: SessionSeq(2), time: 1002, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1,
        stream: [], message: { id: brandString<RecordedMessageId>('remote-message'), role: 'assistant', content: [],
          source: { kind: 'model', provider: 'fixture', model: 'recorded' } } } },
      { seq: SessionSeq(3), time: 1003, type: 'step/end', data: { turn: 1, step: 1 } },
      { seq: SessionSeq(4), time: 1004, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    await f.seed('remote-profile', canonical)
    const spans: ReturnType<typeof decodeSpans> = []
    const failures: unknown[] = []
    const pending = new Set<Promise<void>>()
    const traceReceiver = createServer((request, response) => {
      const operation = (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk))
        expect(request.url).toBe('/v1/traces')
        expect(request.headers.authorization).toBe('Bearer fixture-write-token')
        spans.push(...decodeSpans(Buffer.concat(chunks)))
        response.writeHead(200, { 'content-type': 'application/x-protobuf' })
        response.end()
      })().catch((error: unknown) => { failures.push(error); response.destroy() }).finally(() => { pending.delete(operation) })
      pending.add(operation)
    })
    cleanups.push(async () => {
      traceReceiver.closeAllConnections()
      await new Promise<void>((resolve) => { traceReceiver.close(() => { resolve() }) })
      await Promise.allSettled(pending)
      if (failures.length) throw new AggregateError(failures, 'remote profile trace receiver failed')
    })
    traceReceiver.listen(0, '127.0.0.1')
    await once(traceReceiver, 'listening')
    const address = traceReceiver.address()
    if (address === null || typeof address === 'string') throw new Error('trace fixture address missing')
    const traceEndpoint = `http://127.0.0.1:${address.port}/v1/traces`
    const repo = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '')
    const home = join(f.directory, 'remote-home')
    const profile = join(home, 'profiles', 'course-trajectories-local')
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'package.json'), await readFile(join(repo, 'course/trajectory-collector/profile-local/package.json')))
    const patch = (await readFile(join(repo, 'course/trajectory-collector/profile-local/cordis.patch.yml'), 'utf8'))
      .replaceAll('/opt/dsh', repo).replace('/var/lib/course-sessions', f.source)
      .replaceAll('/var/lib/trajectory', f.stateDir).replace('port: 4319', 'port: 0')
      .replaceAll('/run/secrets/logfire_write_token', f.tokenFile)
      .replaceAll('allowFullContent: true', 'allowFullContent: true\n        allowInsecureLoopback: true\n        pollIntervalMs: 20')
    await writeFile(join(profile, 'cordis.patch.yml'), patch)
    const launch = resolveExampleLaunch({ srcBin: join(repo, 'apps/cli/src/bin.ts'), mode: 'lib',
      configArgs: ['--profile', 'course-trajectories-local'], env: { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED',
        COURSE_SESSION_COMPRESSION: 'none', COURSE_INSTALLATION_ID: 'remote-installation', COURSE_STUDENT_ID: 'remote-student',
        COURSE_COHORT_ID: 'remote-cohort', COURSE_OTLP_LOGS_ENDPOINT: f.endpoint, COURSE_OTLP_TRACES_ENDPOINT: traceEndpoint,
        COURSE_TRAJECTORY_SOURCE_ID: 'remote-fixture' } })
    const child = spawn(launch.command, launch.args, { cwd: dirname(profile), env: { ...process.env, ...launch.env },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.setEncoding('utf8').on('data', (value: string) => { output += value })
    child.stderr.setEncoding('utf8').on('data', (value: string) => { output += value })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    let expired = false
    const deadline = setTimeout(() => { expired = true; child.kill('SIGKILL') }, 30_000)
    cleanups.push(async () => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await exited
      } finally { clearTimeout(deadline) }
    })
    const health = async (signal: string) => JSON.parse(await readFile(join(f.stateDir, signal, 'health.json'), 'utf8')) as { state: string }
    await expect.poll(async () => {
      if (child.exitCode !== null) throw new Error(`remote collector exited ${child.exitCode}: ${output.replace(/token=[^\s]+/g, 'token=[redacted]')}`)
      return (await health('export-traces')).state
    }, { timeout: 15_000 }).toBe('idle')
    await expect.poll(() => spans.length).toBe(5)
    await expect.poll(() => f.records.length).toBe(6)
    expect(f.records.slice(1).map(record => JSON.parse(record.body) as object)).toEqual(canonical)
    expect(spans.map(span => span.attributes['dsh.span.kind']).sort()).toEqual(['event', 'event', 'event', 'model', 'turn'])
    expect(spans.every(span => span.attributes['dsh.course.student.id'] === 'remote-student')).toBe(true)
    const checkpoint = JSON.parse(await readFile(join(f.stateDir, 'export-traces/traces.json'), 'utf8')) as { completionCursor: number }
    expect(checkpoint.completionCursor).toBe(5)
    await expect.poll(async () => (await health('export')).state).toBe('idle')
    expect(await readFile(join(f.stateDir, 'projection/trace-view.db'))).not.toHaveLength(0)

    const login = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/.exec(output)?.[0]
    if (login === undefined) throw new Error('private instructor login origin missing')
    const healthLine = (await readFile(join(repo, 'course/trajectory-collector/compose.local-logfire.yml'), 'utf8'))
      .split('\n').find(line => line.trim().startsWith('test: [CMD, node, --eval, '))?.trim()
    if (healthLine === undefined) throw new Error('remote overlay healthcheck command missing')
    const script = JSON.parse(healthLine.slice('test: [CMD, node, --eval, '.length, -1)) as string
    const probeRoot = join(f.directory, 'health-probe')
    for (const signal of ['export', 'export-traces']) {
      await mkdir(join(probeRoot, signal), { recursive: true })
      await writeFile(join(probeRoot, signal, 'health.json'), JSON.stringify({ state: 'idle', updatedAt: Date.now() }))
    }
    const probe = async () => {
      const command = script.replaceAll('/var/lib/trajectory/', `${probeRoot}/`)
        .replace('http://127.0.0.1:4319', new URL(login).origin)
      const healthChild = spawn(launch.command, ['--eval', command], { stdio: 'ignore' })
      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        healthChild.once('error', reject)
        healthChild.once('close', (code, signal) => { resolve({ code, signal }) })
      })
      let timedOut = false
      const timer = setTimeout(() => { timedOut = true; healthChild.kill('SIGKILL') }, 5000)
      cleanups.push(async () => {
        try { if (healthChild.exitCode === null && healthChild.signalCode === null) healthChild.kill('SIGKILL'); await closed }
        finally { clearTimeout(timer) }
      })
      const result = await closed
      clearTimeout(timer)
      expect(timedOut).toBe(false)
      expect(result.signal).toBe(null)
      return result.code
    }
    expect(await probe()).toBe(0)
    await writeFile(join(probeRoot, 'export-traces/health.json'), JSON.stringify({ state: 'retrying', updatedAt: Date.now() }))
    expect(await probe()).toBe(1)
    await writeFile(join(probeRoot, 'export-traces/health.json'), JSON.stringify({ state: 'idle', updatedAt: 0 }))
    expect(await probe()).toBe(1)
    child.kill('SIGTERM')
    const result = await exited
    expect(expired).toBe(false)
    expect(result).toEqual({ code: 0, signal: null })
    expect((await health('export')).state).toBe('stopped')
    expect((await health('export-traces')).state).toBe('stopped')
  })
