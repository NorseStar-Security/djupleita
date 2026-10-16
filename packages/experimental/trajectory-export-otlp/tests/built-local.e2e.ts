import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { resolveExampleLaunch, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@deepseek-ai/dsh-loader-smoke'
import { cleanups, event, fixture } from './harness.ts'

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'local collector profile cleanup failed')
})

it('runs the built local-only profile, authenticates inspection, and refuses unenrolled uploads', async () => {
  const f = await fixture()
  const canonical = [event(0, '<script>untrusted trajectory</script>')]
  await f.seed('trajectory', canonical)
  const repo = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '')
  const home = join(f.directory, 'local-home')
  const profile = join(home, 'profiles', 'course-trajectories-local')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), await readFile(join(repo, 'course/trajectory-collector/profile-local/package.json')))
  const patch = (await readFile(join(repo, 'course/trajectory-collector/profile-local/cordis.patch.yml'), 'utf8'))
    .replaceAll('/opt/dsh', repo).replace('/var/lib/course-sessions', f.source)
    .replaceAll('/var/lib/trajectory', f.stateDir).replace('port: 4319', 'port: 0')
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
  const launch = resolveExampleLaunch({ srcBin: join(repo, 'apps/cli/src/bin.ts'), mode: 'lib',
    configArgs: ['--profile', 'course-trajectories-local'], env: { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED',
      COURSE_SESSION_COMPRESSION: 'none', COURSE_INSTALLATION_ID: 'installation-fixture', COURSE_STUDENT_ID: 'student-fixture',
      COURSE_COHORT_ID: 'cohort-fixture', COURSE_OTLP_LOGS_ENDPOINT: '', COURSE_OTLP_TRACES_ENDPOINT: '' } })
  const child = spawn(launch.command, launch.args, { cwd: dirname(profile), env: { ...process.env, ...launch.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (value: string) => { output += value })
  child.stderr.setEncoding('utf8').on('data', (value: string) => { output += value })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  const deadline = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
  cleanups.push(async () => {
    try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await exited }
    finally { clearTimeout(deadline) }
  })
  await expect.poll(() => {
    if (child.exitCode !== null) throw new Error(`local collector exited ${child.exitCode}: ${output.replace(/token=[^\s]+/g, 'token=[redacted]')}`)
    return /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/.exec(output)?.[0]
  }, { timeout: 15_000 }).toBeDefined()
  const login = /http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/.exec(output)![0]
  const origin = new URL(login).origin
  expect((await fetch(`${origin}/trajectory`)).status).toBe(401)
  const exchange = await fetch(login, { redirect: 'manual' })
  expect(exchange.status).toBe(303)
  const cookie = exchange.headers.get('set-cookie')!.split(';')[0]!
  const headers = { cookie }
  await expect.poll(async () => {
    const response = await fetch(`${origin}/api/trajectory/records`, { headers })
    expect(response.status).toBe(200)
    const page = await response.json() as { records: { content: string; identity: { studentId: string } }[] }
    return page.records.some(record => record.content === JSON.stringify(canonical[0]) && record.identity.studentId === 'student-fixture')
  }).toBe(true)
  const dashboard = await fetch(`${origin}/trajectory`, { headers })
  expect(dashboard.status).toBe(200)
  expect(await dashboard.text()).not.toContain('<script>untrusted')
  const blocked = await fetch(`${origin}/api/trajectory/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  expect(blocked.status).toBe(503)
  expect(await blocked.text()).toContain('COLLECTOR_UNAVAILABLE')
  expect(f.requests).toHaveLength(0)
  child.kill('SIGTERM')
  expect(await exited).toEqual({ code: 0, signal: null })
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
