import { spawn } from 'node:child_process'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
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
  if (errors.length) throw new AggregateError(errors, 'built collector cleanup failed')
})

// This suite intentionally consumes published lib artifacts under plain Node.
async function launchCollector(missingToken = false) {
  const f = await fixture()
  const canonical = [event(0), event(1, 'out-of-scope call recorded')]
  await f.seed('trajectory', canonical)
  const repo = fileURLToPath(new URL('../../../../', import.meta.url))
  const home = join(f.directory, 'home')
  const profile = join(home, 'profiles', 'course-trajectories')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), await readFile(join(repo, 'course/trajectory-collector/profile/package.json')))
  const patch = (await readFile(join(repo, 'course/trajectory-collector/profile/cordis.patch.yml'), 'utf8'))
    .replaceAll('/opt/dsh', repo.replace(/\/$/, ''))
    .replace('/var/lib/course-sessions', f.source)
    .replace('/var/lib/trajectory', f.stateDir)
    .replace('/run/secrets/logfire_write_token', f.tokenFile)
    .replace('allowFullContent: true', 'allowFullContent: true\n        allowInsecureLoopback: true\n        pollIntervalMs: 20')
  await writeFile(join(profile, 'cordis.patch.yml'), patch)
  const launch = resolveExampleLaunch({
    srcBin: join(repo, 'apps/cli/src/bin.ts'), mode: 'lib', configArgs: ['--profile', 'course-trajectories'],
    env: { DSH_HOME: home, DSH_TELEMETRY_MODE: 'DISABLED', COURSE_SESSION_COMPRESSION: 'none', COURSE_OTLP_LOGS_ENDPOINT: f.endpoint,
      COURSE_TRAJECTORY_SOURCE_ID: 'built-profile-fixture' },
  })
  if (missingToken) await unlink(f.tokenFile)
  const child = spawn(launch.command, launch.args, { cwd: dirname(profile), env: { ...process.env, ...launch.env },
    stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (value: string) => { stdout += value })
  child.stderr.setEncoding('utf8').on('data', (value: string) => { stderr += value })
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolve({ code, signal }) })
  })
  const deadline = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
  cleanups.push(async () => {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await exited
    } finally { clearTimeout(deadline) }
  })
  return { f, canonical, child, exited, output: () => `${stdout}\n${stderr}` }
}

it('runs the instructor collector profile through the built dsh launcher and drains on SIGTERM', async () => {
  const { f, canonical, child, exited, output } = await launchCollector()
  await expect.poll(async () => {
    if (child.exitCode !== null) throw new Error(`collector exited ${child.exitCode}: ${output()}`)
    return (await f.health()).state
  }, { timeout: 10_000 }).toBe('idle')
  expect(f.records.slice(1).map(record => JSON.parse(record.body) as object)).toEqual(canonical)
  expect(f.records.every(record => record.attributes['dsh.source.id'] === 'built-profile-fixture')).toBe(true)
  child.kill('SIGTERM')
  expect(await exited).toEqual({ code: 0, signal: null })
  expect((await f.health()).state).toBe('stopped')
}, LOADER_SMOKE_TEST_TIMEOUT_MS)

it('exits non-zero when the instructor profile credential file is genuinely missing', async () => {
  const { f, exited, output } = await launchCollector(true)
  const result = await exited
  expect(result.signal).toBe(null)
  expect(result.code).not.toBe(0)
  expect(output()).toContain('TRAJECTORY_STARTUP_FAILED')
  expect(f.requests).toHaveLength(0)
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
