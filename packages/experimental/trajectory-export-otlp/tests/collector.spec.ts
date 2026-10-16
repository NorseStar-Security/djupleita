import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CohortId, CollectorIdentity, InstallationId, StudentId, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import { cleanups, event, fixture } from './harness.ts'

afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'collector export cleanup failed')
})

function identity(installation = 'installation-a'): CollectorIdentity {
  return { installationId: brandString<InstallationId>(installation), studentId: brandString<StudentId>('student-a'), cohortId: brandString<CohortId>('cohort-a') }
}
function header(): TrajectoryRecord {
  return { sessionId: SessionId('same-session'), sequence: -1, type: 'session/header', timestamp: 1000,
    content: JSON.stringify({ header: { id: 'same-session', createdAt: 1000 }, inheritedEventCount: 0 }) }
}
function record(title = 'dsh.course.student.id=forged'): TrajectoryRecord {
  const data = event(0, title)
  return { sessionId: SessionId('same-session'), sequence: 0, type: data.type, timestamp: data.time, content: JSON.stringify(data) }
}

it('exports committed records with trusted identity and separates colliding session IDs', async () => {
  const f = await fixture({}, undefined, true)
  const ctx = await f.boot()
  const a = await ctx.trajectoryCollector.append(identity(), header())
  await ctx.trajectoryCollector.append(identity(), record())
  const b = await ctx.trajectoryCollector.append(identity('installation-b'), header())
  await expect.poll(async () => (await ctx.trajectoryCollector.status()).exportedCursor).toBe(3)
  expect(f.records.map(value => value.body)).toEqual([header().content, record().content, header().content])
  expect(f.records[0]!.attributes['dsh.record.id']).toBe(a.id)
  expect(f.records[2]!.attributes['dsh.record.id']).toBe(b.id)
  expect(a.id).not.toBe(b.id)
  expect(f.records[1]!.attributes).toMatchObject({ 'dsh.course.student.id': 'student-a',
    'dsh.course.cohort.id': 'cohort-a', 'dsh.course.installation.id': 'installation-a' })
})

it('keeps intake through an outage and resumes the durable acknowledgement cursor after restart', async () => {
  const f = await fixture({}, undefined, true)
  f.state.status = 503
  let ctx = await f.boot()
  const receipt = await ctx.trajectoryCollector.append(identity(), header())
  await ctx.trajectoryCollector.append(identity(), record())
  await expect.poll(async () => (await f.health()).state).toBe('retrying')
  expect((await ctx.trajectoryCollector.status()).exportedCursor).toBe(0)
  await f.stop()
  f.state.status = 200
  ctx = await f.boot()
  await expect.poll(async () => (await ctx.trajectoryCollector.status()).exportedCursor).toBe(2)
  expect(f.records.filter(value => value.attributes['dsh.record.id'] === receipt.id).length).toBeGreaterThanOrEqual(2)
  await f.stop()
  const count = f.records.length
  ctx = await f.boot()
  await expect.poll(async () => (await f.health()).state).toBe('idle')
  expect(f.records).toHaveLength(count)
  expect((await ctx.trajectoryCollector.read({ after: 0, limit: 10, maxBytes: 10000 })).records).toHaveLength(2)
})

it('does not acknowledge a collector event until all fragments are accepted', async () => {
  const f = await fixture({ fragmentBytes: 128 }, undefined, true)
  const ctx = await f.boot()
  await ctx.trajectoryCollector.append(identity(), header())
  await ctx.trajectoryCollector.append(identity(), record('安全🔬'.repeat(300)))
  f.state.callback = () => {
    const value = f.records.at(-1)!
    if (value.attributes['dsh.event.seq'] === '0' && value.attributes['dsh.record.part'] === '1') f.state.hang = true
  }
  await expect.poll(() => f.state.hang).toBe(true)
  expect((await ctx.trajectoryCollector.status()).exportedCursor).toBe(1)
  await f.stop()
  f.state.hang = false
  f.state.callback = undefined
  const resumed = await f.boot()
  await expect.poll(async () => (await resumed.trajectoryCollector.status()).exportedCursor).toBe(2)
  const parts = f.records.filter(value => value.attributes['dsh.event.seq'] === '0')
  expect(parts.filter(value => value.attributes['dsh.record.part'] === '0')).toHaveLength(2)
})

it('rejects a new destination even with a fresh exporter checkpoint directory', async () => {
  const f = await fixture({}, undefined, true)
  const ctx = await f.boot()
  await ctx.trajectoryCollector.append(identity(), header())
  await expect.poll(async () => (await ctx.trajectoryCollector.status()).exportedCursor).toBe(1)
  await f.stop()
  const count = f.requests.length
  const nextState = join(f.directory, 'new-export-state')
  const changed = await f.boot({ sourceId: 'different-destination', stateDir: nextState })
  await expect.poll(() => changed.logger.buffer.some(value => value.args.join(' ').includes('export stopped'))).toBe(true)
  expect(f.requests).toHaveLength(count)
  expect((await changed.trajectoryCollector.status()).exportedCursor).toBe(1)
})
