import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { composition, context, evidence, session } from './fixture.ts'
import type { GraphEvaluation } from '../src/graph.ts'

const observedAt = '2026-10-01T00:00:00.000Z'
const graphEvidence = { ...evidence, observedAt }
const native = (nativeId: string, realm = 'account-one') => ({ provider: 'fixture', realm, nativeType: 'Resource', nativeId })
const inventory = [
  { kind: 'identity', value: 'Assessment principal', identity: native('principal') },
  { kind: 'resource', value: 'Application workload', identity: native('workload') },
  { kind: 'resource', value: 'Payment data', identity: native('data') },
  { kind: 'business-service', value: 'Payments', identity: native('payments') },
  { kind: 'resource', value: 'Access prerequisite', identity: native('guard') },
].map(value => ({ ...value, attributes: { configuration: 'v1' }, confidence: 0.9, basis: 'observed' }))

async function graph(options: Parameters<typeof composition>[0] = {}) {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime('2026-10-15T12:00:00.000Z')
  const fixture = await composition(options)
  await fixture.memory.begin(session, context)
  const receipt = await fixture.record('inventory', { kind: 'capture', observations: inventory,
    evidence: graphEvidence, coverage: 'partial' })
  const [entry, workload, target, service, guard] = receipt.assetIds
  const objective = { kind: 'objective', id: 'payments', expectedRevision: 0,
    businessServiceId: service, assetIds: [entry, workload, target, guard], title: 'Payment data confidentiality', owner: 'Payments team',
    businessImpact: 'Unauthorized access to payment data', successCriteria: ['Establish whether the assessment principal can read payment data'],
    evidence: graphEvidence }
  await fixture.record('objective', objective)
  const capability = { kind: 'capability', id: 'invoke', expectedRevision: 0, source: entry, target: workload,
    action: 'CanInvoke', validationMethod: 'Validate application access', configurationFingerprint: 'fixture-v1', context,
    state: 'available', conditions: [], requires: [], supportObservationIds: receipt.observationIds.slice(0, 2),
    validFrom: '2026-10-01T00:00:00.000Z', validUntil: '2026-11-01T00:00:00.000Z', evidence: graphEvidence }
  const read = { ...capability, id: 'read', source: workload, target,
    action: 'CanReadData', validationMethod: 'Validate data access', requires: ['invoke'],
    supportObservationIds: receipt.observationIds.slice(1, 3) }
  const path = { kind: 'path', id: 'payment-path', expectedRevision: 0, entry, target,
    capabilityIds: ['invoke', 'read'], objectiveId: 'payments', evidence: graphEvidence }
  const attempt = { kind: 'attempt', id: 'invoke-check', assetIds: [entry, workload],
    method: capability.validationMethod, toolVersion: 'fixture-v1', context, outcome: 'completed', conclusion: 'confirmed',
    evidence: graphEvidence, applicableUntil: '2026-10-31T00:00:00.000Z', configurationFingerprint: 'fixture-v1' }
  const plan = { kind: 'coverage-plan', id: 'payment-coverage', expectedRevision: 0, assetIds: [workload, target],
    objectiveId: 'payments', method: read.validationMethod, context, configurationFingerprint: 'fixture-v1', evidence: graphEvidence }
  return { ...fixture, memoryPath: fixture.path, receipt, entry, workload, target, service, guard,
    capability, read, path, attempt, plan, objective }
}

describe('evidence-supported assessment paths through Loader and SQLite', () => {
  it('retains native identity across labels, separates realms and exposes observation and recording times', async () => {
    const fixture = await graph()
    const renamed = await fixture.record('renamed', { kind: 'capture', observations: [{ ...inventory[1],
      value: 'Renamed workload' }], evidence: graphEvidence, coverage: 'partial' })
    expect(renamed.assetIds[0]).toBe(fixture.workload)
    const otherRealm = await fixture.record('other-realm', { kind: 'capture', observations: [{ ...inventory[1],
      identity: native('workload', 'account-two') }], evidence: graphEvidence, coverage: 'partial' })
    expect(otherRealm.assetIds[0]).not.toBe(fixture.workload)
    const exported = await fixture.memory.rage(session)
    expect(exported).toContain('fixture|account-one|Resource|workload')
    expect(exported).toContain('fixture|account-two|Resource|workload')
    expect((await fixture.query('observations')).items[0]).toMatchObject({ observedAt,
      recordedAt: '2026-10-15T12:00:00.000Z' })
  })

  it('validates a supported path, invalidates it on changed facts, generates retest work atomically and replays it', async () => {
    const f = await graph()
    await f.record('invoke', f.capability)
    await f.record('read', f.read)
    await f.record('path', f.path)
    expect((await f.query('paths')).items[0]?.evaluation).toMatchObject({ state: 'active', assurance: 'observed' })
    await f.record('invoke-attempt', f.attempt)
    await f.record('validate-invoke', { ...f.capability, expectedRevision: 1, verificationAttemptId: f.attempt.id })
    await f.record('read-attempt', { ...f.attempt, id: 'read-check', method: f.read.validationMethod,
      assetIds: [f.workload, f.target] })
    await f.record('validate-read', { ...f.read, expectedRevision: 1, verificationAttemptId: 'read-check' })
    await f.record('validate-path', { ...f.path, expectedRevision: 1 })
    expect((await f.query('paths')).items[0]?.evaluation).toMatchObject({ state: 'active', assurance: 'validated',
      needsRevalidation: false, confidence: 0.9 })
    const before = (await f.query('tasks')).items.filter(task => task.id.startsWith('retest:')).length
    const update = { kind: 'capture', observations: [{ ...inventory[1], attributes: { configuration: 'v2' } }],
      evidence: { ...graphEvidence, observedAt: '2026-10-15T12:00:00.000Z' }, coverage: 'partial' }
    await f.record('configuration-change', update)
    const result = (await f.query('paths')).items[0]?.evaluation
    expect(result).toMatchObject({ state: 'needs-revalidation', assurance: 'observed', needsRevalidation: true })
    const tasks = (await f.query('tasks')).items.filter(task => task.id.startsWith('retest:'))
    expect(tasks.length).toBeGreaterThan(before)
    expect(tasks.some(task => String(task.reason).includes('asset-changed'))).toBe(true)
    await f.record('same-configuration', update)
    expect((await f.query('tasks')).items.filter(task => task.id.startsWith('retest:'))).toHaveLength(tasks.length)
    await expect(f.record('reuse-stale-validation', { ...f.capability, expectedRevision: 2,
      verificationAttemptId: f.attempt.id })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await f.ctx.fiber.dispose()
    const replay = await composition({ path: f.memoryPath })
    await replay.memory.begin(session, context)
    expect((await replay.query('paths')).items[0]?.evaluation).toEqual(result)
    expect((await replay.query('tasks')).items.filter(task => task.id.startsWith('retest:'))).toHaveLength(tasks.length)
    await replay.record('third-configuration', { ...update,
      observations: [{ ...inventory[1], attributes: { configuration: 'v3' } }] })
    expect((await replay.query('tasks')).items.filter(task => task.id.startsWith('retest:')).length).toBeGreaterThan(tasks.length)
  })

  it('checks off-path AND prerequisites, conditions, cycles and direction instead of treating connectivity as access', async () => {
    const f = await graph()
    await f.record('guard', { ...f.capability, id: 'guard', target: f.guard, state: 'blocked',
      supportObservationIds: [f.receipt.observationIds[4]] })
    await f.record('invoke', { ...f.capability, requires: ['guard'] })
    await f.record('read', f.read)
    await f.record('path', f.path)
    const result = JSON.parse(await f.memory.paths(session, { entry: f.entry!, target: f.target! })) as {
      paths: { evaluation: { state: string; capabilityIds: string[]; reasons: string[] } }[]
    }
    expect(result.paths[0]?.evaluation).toMatchObject({ state: 'blocked', capabilityIds: ['invoke', 'guard', 'read'] })
    await expect(f.record('cycle', { ...f.capability, id: 'guard', target: f.guard,
      expectedRevision: 1, requires: ['read'] })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await expect(f.record('reversed', { ...f.path, capabilityIds: ['read', 'invoke'] })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await f.record('conditional', { ...f.capability, id: 'conditional', target: f.target,
      conditions: [{ id: 'approval', description: 'Required access condition', satisfied: false }] })
    expect((await f.query('capabilities', { search: 'conditional' })).items[0]?.evaluation).toMatchObject({ state: 'conditional' })
    await f.record('unknown', { ...f.capability, id: 'unknown', target: f.target,
      conditions: [{ id: 'unknown', description: 'Uncollected condition', satisfied: null }] })
    expect((await f.query('capabilities', { search: '"id":"unknown"' })).items[0]?.evaluation).toMatchObject({ state: 'unknown' })
  })

  it('rejects inferred support, missing references, wrong contexts and unrelated test promotions without partial writes', async () => {
    const f = await graph()
    const inferred = await f.record('inferred', { kind: 'capture', observations: [{ ...inventory[4], basis: 'inferred' }],
      evidence: graphEvidence, coverage: 'partial' })
    await expect(f.record('bad-support', { ...f.capability,
      supportObservationIds: inferred.observationIds })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await expect(f.record('bad-context', { ...f.capability, context: { ...context, principal: 'different' } })).rejects.toHaveProperty('code', 'MEMORY_BINDING')
    await f.record('unrelated-test', { ...f.attempt, method: 'An unrelated check' })
    await expect(f.record('bad-promotion', { ...f.capability,
      verificationAttemptId: f.attempt.id })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await expect(f.record('bad-reference', { ...f.capability, requires: ['missing'] })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    expect((await f.query('capabilities')).total).toBe(0)
    await f.record('invoke', f.capability)
    await f.record('correction', { kind: 'retract', observationId: f.receipt.observationIds[0], reason: 'Incorrect source evidence',
      evidence: graphEvidence })
    expect((await f.query('capabilities')).items[0]?.evaluation).toMatchObject({ needsRevalidation: true })
  })

  it('requires reachable sources for prerequisite branches and keeps known blockers visible beside stale support', async () => {
    const f = await graph()
    await f.record('unreachable-prerequisite', { ...f.capability, id: 'guard', source: f.guard, target: f.target,
      supportObservationIds: [f.receipt.observationIds[4]] })
    await f.record('invoke', { ...f.capability, requires: ['guard'] })
    await f.record('read', f.read)
    await f.record('path', f.path)
    const unknown = (await f.query('paths')).items[0]?.evaluation as GraphEvaluation
    expect(unknown).toMatchObject({ state: 'unknown', assurance: 'observed' })
    expect(unknown.reasons).toContain('unknown:guard:prerequisite-source-unreached')
    await f.record('blocked-guard', { ...f.capability, id: 'guard', source: f.entry, target: f.guard,
      expectedRevision: 1, state: 'blocked' })
    const blocked = (await f.query('paths')).items[0]?.evaluation as GraphEvaluation
    expect(blocked).toMatchObject({ state: 'blocked', needsRevalidation: true })
    expect(blocked.reasons).toContain('blocked:guard')
    expect(blocked.reasons).toContain('revision:invoke:prerequisite-changed:guard')
    expect((await f.query('tasks')).items.some(task => String(task.reason).includes('prerequisite-changed'))).toBe(true)
  })

  it('requires new evidence, attempts and deliberate revision updates to restore a changed path', async () => {
    const f = await graph()
    await f.record('invoke', f.capability)
    await f.record('read', f.read)
    await f.record('path', f.path)
    const updated = await f.record('new-workload', { kind: 'capture', observations: [{ ...inventory[1],
      attributes: { configuration: 'v2' } }], evidence: graphEvidence, coverage: 'partial' })
    const invoke = { ...f.capability, expectedRevision: 1, configurationFingerprint: 'fixture-v2',
      supportObservationIds: [f.receipt.observationIds[0], updated.observationIds[0]] }
    const read = { ...f.read, expectedRevision: 1, configurationFingerprint: 'fixture-v2',
      supportObservationIds: [updated.observationIds[0], f.receipt.observationIds[2]] }
    await f.record('invoke-attempt', { ...f.attempt, configurationFingerprint: 'fixture-v2' })
    await f.record('invoke-v2', { ...invoke, verificationAttemptId: f.attempt.id })
    await f.record('read-attempt', { ...f.attempt, id: 'read-check', method: f.read.validationMethod,
      assetIds: [f.workload, f.target], configurationFingerprint: 'fixture-v2' })
    await f.record('read-v2', { ...read, verificationAttemptId: 'read-check' })
    expect((await f.query('paths')).items[0]?.evaluation).toMatchObject({ needsRevalidation: true })
    await f.record('path-v2', { ...f.path, expectedRevision: 1 })
    expect((await f.query('paths')).items[0]?.evaluation).toMatchObject({ state: 'active', assurance: 'validated',
      needsRevalidation: false })
    const work = (await f.query('tasks')).items.find(task => task.id.startsWith('retest:'))!
    await f.record('claim-review', { kind: 'claim', taskId: work.id, expectedRevision: work.revision })
    await f.record('settle-review', { kind: 'task-settle', taskId: work.id, expectedRevision: work.revision + 1,
      status: 'done', reason: 'Reviewed the replacement observations, matching attempts and updated path.' })
    expect((await f.query('tasks')).items.find(task => task.id === work.id)?.status).toBe('done')
  })

  it('distinguishes expiration and access contexts, and reports search truncation explicitly', async () => {
    const f = await graph({ extra: { maxPathDepth: 1, maxPathExpansions: 1 } })
    await f.record('invoke', f.capability)
    await f.record('read', f.read)
    await f.record('path', f.path)
    expect(JSON.parse(await f.memory.paths(session, { entry: f.entry!, target: f.target! }))).toMatchObject({ paths: [], truncated: true })
    const other = SessionId('internal-operator')
    await f.memory.begin(other, { ...context, vantage: 'internal' })
    const changed = JSON.parse(await f.memory.query(other, { view: 'paths' })) as { items: { evaluation: unknown }[] }
    expect(changed.items[0]?.evaluation).toMatchObject({ needsRevalidation: true, state: 'needs-revalidation' })
    vi.setSystemTime('2026-11-01T00:00:00.000Z')
    expect((await f.query('paths')).items[0]?.evaluation).toMatchObject({ state: 'needs-revalidation' })
    await f.record('handoff', { kind: 'handoff', summary: 'Review expired assumptions', nextActions: [], evidence: graphEvidence })
    expect((await f.query('tasks')).items.some(task => task.id.startsWith('retest:'))).toBe(true)
  })

  it('charges prerequisite evaluation to the search budget and never validates an incomplete explanation', async () => {
    const f = await graph({ extra: { maxPathDepth: 8, maxPathExpansions: 3 } })
    await f.record('invoke', f.capability)
    await f.record('read', f.read)
    const result = JSON.parse(await f.memory.paths(session, { entry: f.entry!, target: f.target! })) as {
      truncated: boolean
      expansions: number
      paths: { evaluation: GraphEvaluation }[]
    }
    expect(result.truncated).toBe(true)
    expect(result.expansions).toBe(3)
    expect(result.paths[0]?.evaluation).toMatchObject({ state: 'unknown', assurance: 'observed', confidence: 0 })
  })

  it('tracks per-asset planned coverage, preserves failed and changed attempts, and does not reuse different access conditions', async () => {
    const f = await graph()
    await f.record('coverage', f.plan)
    expect((await f.query('coverage-matrix')).items.map(item => item.status)).toEqual(['untested', 'untested'])
    await f.record('different-context', { ...f.attempt, method: f.read.validationMethod,
      assetIds: [f.workload, f.target], context: { ...context, principal: 'different' } })
    expect((await f.query('coverage-matrix')).items.map(item => item.status)).toEqual(['untested', 'untested'])
    await f.record('not-reproduced', { ...f.attempt, id: 'z-earlier', method: f.read.validationMethod,
      assetIds: [f.workload, f.target], conclusion: 'not-reproduced' })
    expect((await f.query('coverage-matrix')).items.map(item => item.status)).toEqual(['not-reproduced', 'not-reproduced'])
    await f.record('failure', { ...f.attempt, id: 'a-latest', method: f.read.validationMethod,
      assetIds: [f.workload, f.target], outcome: 'failed-to-execute', conclusion: 'inconclusive' })
    expect((await f.query('coverage-matrix')).items.map(item => item.status)).toEqual(['failed-to-execute', 'failed-to-execute'])
    await f.record('change', { kind: 'capture', observations: [{ ...inventory[1], attributes: { configuration: 'v2' } }],
      evidence: { ...graphEvidence, observedAt: '2026-10-15T12:00:00.000Z' }, coverage: 'partial' })
    expect((await f.query('coverage-matrix')).items.map(item => item.status)).toEqual(['needs-revalidation', 'needs-revalidation'])
  })
})
