import { describe, expect, it, vi } from 'vitest'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SessionId, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { importRage } from '../src/rage.ts'
import { composition, evidence, context, observation, capture, session } from './fixture.ts'

describe('assessment memory through Loader and SQLite', () => {
  it('requires binding, canonicalizes discoveries, deduplicates retries and retains separate observations', async () => {
    const { memory, record, query } = await composition()
    await expect(record('first', capture)).rejects.toHaveProperty('code', 'MEMORY_BINDING')
    await memory.begin(session, context)
    await expect(record('invalid-reference', { ...capture,
      relationships: [{ sourceIndex: 0, targetIndex: 1, relation: 'x-assessment:AssociatedWith' }] })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    expect((await query('assets')).items).toHaveLength(0)
    const first = await record('first', capture)
    expect(await record('first', capture)).toEqual(first)
    await expect(record('first', { ...capture, observations: [{ ...observation,
      value: 'other.example.test' }] })).rejects.toHaveProperty('code', 'MEMORY_CONFLICT')
    await record('second', { ...capture, observations: [{ ...observation, value: 'api.example.test' }] })
    expect((await query('assets')).items).toHaveLength(1)
    expect((await query('assets')).items[0]?.value).toBe('api.example.test')
    expect((await query('observations')).items).toHaveLength(2)
    expect((await query('tasks')).items).toHaveLength(1)
    await expect(memory.begin(session, { ...context, principal: 'employee' })).rejects.toHaveProperty('code', 'MEMORY_CONFLICT')
  })

  it('replays durable knowledge in a second engagement and keeps old access contexts separate', async () => {
    const first = await composition()
    await first.memory.begin(session, context)
    const receipt = await first.record('first', capture)
    await first.ctx.fiber.dispose()
    const second = await composition({ path: first.path, extra: { assessmentId: 'assessment-2' } })
    const nextSession = SessionId('operator-two')
    await second.memory.begin(nextSession, context)
    const rows = JSON.parse(await second.memory.query(nextSession, { view: 'assets' })) as { items: { id: string }[] }
    expect(rows.items[0]?.id).toBe(receipt.assetIds[0])
    expect((JSON.parse(await second.memory.query(nextSession, { view: 'assessments' })) as { total: number }).total).toBe(2)
    await expect(second.memory.record(session, 'old-session', capture)).rejects.toHaveProperty('code', 'MEMORY_BINDING')
  })

  it('serializes conflicting task claims and checks revisions, prerequisites and ownership', async () => {
    const { memory, record, query } = await composition()
    await memory.begin(session, context)
    await record('capture', capture)
    const task = (await query('tasks')).items[0]!
    await memory.begin(SessionId('operator-two'), context)
    const results = await Promise.allSettled([
      memory.record(session, 'claim-one', { kind: 'claim', taskId: task.id, expectedRevision: task.revision }),
      memory.record(SessionId('operator-two'), 'claim-two', { kind: 'claim', taskId: task.id, expectedRevision: task.revision }),
    ])
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    await expect(memory.record(SessionId('operator-two'), 'settle-other', { kind: 'task-settle', taskId: task.id,
      expectedRevision: 2, status: 'done', reason: 'Reviewed' })).rejects.toHaveProperty('code', 'MEMORY_CONFLICT')
    await record('settle', { kind: 'task-settle', taskId: task.id, expectedRevision: 2, status: 'done', reason: 'Ownership reviewed' })
    expect((await query('tasks')).items[0]?.status).toBe('done')
  })

  it('retains corrections, invalidates supporting relationships and preserves historical evidence', async () => {
    const { memory, record, query } = await composition()
    await memory.begin(session, context)
    const first = await record('first', capture)
    const second = await record('second', { ...capture, observations: [{ ...observation, value: 'other.example.test' }] })
    await record('relationship', { kind: 'relate', source: first.assetIds[0], target: second.assetIds[0],
      relation: 'x-assessment:AssociatedWith', state: 'inferred', confidence: 0.3, evidence })
    await record('correction', { kind: 'retract', observationId: first.observationIds[0], reason: 'Incorrect association', evidence })
    expect((await query('assets')).items).toHaveLength(1)
    expect((await query('observations')).items).toHaveLength(2)
    expect((await query('relations')).items[0]?.supported).toBe(false)
    expect((await query('evidence')).items).toHaveLength(4)
  })

  it('requires a completed retest before fix verification and separates detection evidence', async () => {
    const { memory, record, query } = await composition()
    await memory.begin(session, context)
    const asset = (await record('capture', capture)).assetIds[0]
    const finding = { kind: 'finding', id: 'finding-1', expectedRevision: 0, assetIds: [asset], title: 'Fixture exposure',
      businessImpact: 'Business service access', owner: 'Service team', severity: 'high', status: 'open', evidence }
    await record('finding', finding)
    await expect(record('premature-fix', { ...finding, expectedRevision: 1,
      status: 'fix-verified' })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    const attempt = { kind: 'attempt', id: 'retest-1', assetIds: [asset], method: 'Fixture check', toolVersion: 'fixture-v1', context,
      outcome: 'failed-to-execute', conclusion: 'not-reproduced', evidence, applicableUntil: '2099-01-01T00:00:00.000Z',
      configurationFingerprint: 'fixture-config' }
    await expect(record('failed-check', attempt)).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await record('retest', { ...attempt, outcome: 'completed' })
    await record('verified', { ...finding, expectedRevision: 1, status: 'fix-verified', verificationAttemptId: 'retest-1' })
    await record('detection', { kind: 'detection', attemptId: 'retest-1', telemetry: 'observed', alert: 'unknown',
      response: 'unknown', evidence })
    expect((await query('findings')).items[0]?.status).toBe('fix-verified')
    expect((await query('detections')).items[0]?.alert).toBe('unknown')
  })

  it('tracks cleanup, hypotheses, handoffs and explicit applicability', async () => {
    const { memory, record, query } = await composition()
    await memory.begin(session, context)
    const asset = (await record('capture', capture)).assetIds[0]
    await record('artifact', { kind: 'artifact', id: 'artifact-1', expectedRevision: 0, assetIds: [asset],
      description: 'Temporary test account', owner: 'Operator', expiresAt: evidence.observedAt, vaultRef: 'vault:fixture',
      status: 'present', evidence })
    expect((await query('artifacts')).items[0]?.overdue).toBe(true)
    const hypothesis = { kind: 'hypothesis', id: 'hypothesis-1', expectedRevision: 0, assetIds: [asset], relationIds: [],
      question: 'Can this reach the business service?', businessImpact: 'Service access',
      prerequisites: ['Verify identity permissions'], status: 'possible', evidence }
    await record('hypothesis', hypothesis)
    await expect(record('unsupported-path', { ...hypothesis, expectedRevision: 1,
      status: 'validated' })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await record('handoff', { kind: 'handoff', summary: 'Ownership review remains',
      nextActions: ['Confirm ownership with evidence'], evidence })
    expect((await query('handoffs')).items).toHaveLength(1)
  })

  it('exports attributed evidence-linked RAGE, imports as hypotheses and rejects malformed bundles', async () => {
    const { memory, record, query } = await composition()
    await memory.begin(session, context)
    await record('capture', capture)
    const output = await memory.rage(session)
    const records = output.trim().split('\n').map(line => JSON.parse(line) as { kind: string; [key: string]: unknown })
    expect(records[0]?.spec_version).toBe('0.1')
    expect(JSON.stringify(records[0])).toContain('rage.fail')
    expect(records.some(record => record.kind === 'fact' && record.evidence)).toBe(true)
    const imported = await memory.rage(session, output, 'import-1')
    expect(await memory.rage(session, output, 'import-1')).toBe(imported)
    expect((await query('assets')).items).toHaveLength(2)
    const reexported = await memory.rage(session)
    expect(importRage(reexported).observations).toHaveLength(1)
    expect(() => importRage('{"kind":"manifest","spec_version":"9"}')).toThrow()
    expect(() => importRage('{"kind":"manifest","spec_version":"0.1"}\n{"kind":"node","node_id":"bad","node_type":"Resource"}')).toThrow()
  })

  it('enforces expiry and complete byte budgets without partially publishing an event', async () => {
    const expired = await composition({ extra: { validUntil: '2021-01-01T00:00:00.000Z' } })
    await expect(expired.memory.begin(session, context)).rejects.toHaveProperty('code', 'MEMORY_EXPIRED')
    const { memory, record, query } = await composition({ extra: { maxEventBytes: 2000 } })
    await memory.begin(session, context)
    await expect(record('oversized', { ...capture, observations: [{ ...observation,
      attributes: { large: 'é'.repeat(1500) } }] })).rejects.toHaveProperty('code', 'MEMORY_LIMIT')
    expect((await query('assets')).items).toHaveLength(0)
    await record('fits', capture)
    await expect(query('assets', { limit: 0 })).rejects.toHaveProperty('code', 'MEMORY_LIMIT')
    expect((await query('assets', { limit: 1 })).nextOffset).toBeNull()
  })

  it('bounds large capture receipts while preserving every durable observation', async () => {
    const { memory, record, query } = await composition({ extra: { maxPageItems: 2, maxResultBytes: 4096 } })
    await memory.begin(session, context)
    const receipt = await record('large', { ...capture, observations: Array.from({ length: 20 }, (_,
      index) => ({ ...observation, value: `host${index}.example.test` })) })
    expect(receipt.assetIds).toHaveLength(2)
    expect((await query('assets', { limit: 1 })).total).toBe(20)
    expect(await record('large', { ...capture, observations: Array.from({ length: 20 }, (_, index) => ({ ...observation,
      value: `host${index}.example.test` })) })).toEqual(receipt)
  })

  it('invalidates earlier attempts after changed observations and rejects stale fix claims', async () => {
    const { memory, record, query } = await composition()
    await memory.begin(session, context)
    const asset = (await record('capture', capture)).assetIds[0]
    const finding = { kind: 'finding', id: 'finding-1', expectedRevision: 0, assetIds: [asset], title: 'Fixture exposure',
      businessImpact: 'Business service access', owner: 'Service team', severity: 'high', status: 'open', evidence }
    await record('finding', finding)
    await record('retest', { kind: 'attempt', id: 'retest', assetIds: [asset], method: 'Fixture check', toolVersion: 'fixture-v1', context,
      outcome: 'completed', conclusion: 'not-reproduced', evidence, applicableUntil: '2099-01-01T00:00:00.000Z',
      configurationFingerprint: 'fixture-config' })
    await record('changed', { ...capture, observations: [{ ...observation, attributes: { status: 200 } }] })
    expect((await query('attempts')).items[0]?.observedAssetChanged).toBe(true)
    expect((await query('tasks')).items).toHaveLength(2)
    await expect(record('stale-fix', { ...finding, expectedRevision: 1, status: 'fix-verified',
      verificationAttemptId: 'retest' })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await record('failed', { kind: 'attempt', id: 'failed', assetIds: [asset], method: 'Fixture check', toolVersion: 'fixture-v1', context,
      outcome: 'failed-to-execute', conclusion: 'inconclusive', evidence, applicableUntil: '2099-01-01T00:00:00.000Z',
      configurationFingerprint: 'fixture-config' })
    expect((await query('metrics')).items[0]?.inconclusiveAttempts).toBe(1)
  })

  it('expires claims, preserves lease decisions on replay and rejects prerequisite cycles', async () => {
    const first = await composition({ extra: { claimLeaseMs: 1000 } })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-10-01T00:00:00.000Z')
    await first.memory.begin(session, context)
    const asset = (await first.record('capture', capture)).assetIds[0]
    const task = { kind: 'task', id: 'task-a', expectedRevision: 0, title: 'Review', reason: 'Fixture', assetIds: [asset],
      prerequisites: [], priority: 'medium', retryWhen: 'Changed', stopWhen: 'Reviewed' }
    await first.record('a', task)
    await first.record('b', { ...task, id: 'task-b', prerequisites: ['task-a'] })
    await expect(first.record('cycle', { ...task, expectedRevision: 1,
      prerequisites: ['task-b'] })).rejects.toHaveProperty('code', 'MEMORY_REFERENCE')
    await expect(first.record('blocked', { kind: 'claim', taskId: 'task-b',
      expectedRevision: 1 })).rejects.toHaveProperty('code', 'MEMORY_CONFLICT')
    await first.record('claim-a', { kind: 'claim', taskId: 'task-a', expectedRevision: 1 })
    vi.setSystemTime('2026-10-01T00:00:02.000Z')
    await expect(first.record('expired', { kind: 'task-settle', taskId: 'task-a', expectedRevision: 2, status: 'done',
      reason: 'Reviewed' })).rejects.toHaveProperty('code', 'MEMORY_CONFLICT')
    await first.record('reclaim', { kind: 'claim', taskId: 'task-a', expectedRevision: 2 })
    await first.record('settle', { kind: 'task-settle', taskId: 'task-a', expectedRevision: 3, status: 'done', reason: 'Reviewed' })
    await first.ctx.fiber.dispose()
    const second = await composition({ path: first.path, extra: { claimLeaseMs: 60000 } })
    expect((await second.query('tasks', { search: 'task-a' })).items.find(item => item.id === 'task-a')?.status).toBe('done')
  })

  it('captures accepted recon outcomes and DNS relationships through real Tools and logs a receipt', async () => {
    const { ctx, memory, query } = await composition()
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(session)
    const result = { component: 'dnsx', mode: 'active', targets: ['api.example.test'], policyHash: 'fixture-policy',
      coverage: 'best-effort', diagnosticsPresent: false,
      observations: [{ kind: 'domain', value: 'api.example.test', source: 'dnsx', inScope: true }, { kind: 'ip',
        value: '198.51.100.1', subject: 'api.example.test', source: 'dnsx', inScope: false }] }
    ctx.tools.register(defineTool({ name: 'recon_run', description: 'Fixture recon inventory', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => JSON.stringify(result) }))
    const call = async (id: string) => ctx.tools.execute({ name: 'recon_run', arguments: {}, callId: ToolCallId(id),
      signal: new AbortController().signal, agent })
    expect((await call('unbound')).isError).toBe(true)
    await memory.begin(session, context)
    expect((await call('discovery')).isError).toBe(false)
    expect((await query('assets')).items).toHaveLength(2)
    expect((await query('relations')).items[0]?.relation).toBe('x-assessment:ResolvesTo')
    expect((await call('discovery-repeat')).isError).toBe(false)
    expect((await query('assets')).items).toHaveLength(2)
    expect((await query('relations')).items).toHaveLength(1)
    expect((await query('relations')).items[0]?.assertionIds).toHaveLength(2)
    expect((await query('tasks')).items).toHaveLength(2)
    expect((await query('coverage')).items[0]?.result).toBeTruthy()
    expect((JSON.parse(await memory.status()) as { automaticAdapters: string[] }).automaticAdapters).toEqual(['recon_run'])
    expect((await query('journal')).items.some(item => (item.payload as { kind: string }).kind === 'result')).toBe(true)
    expect(ctx.tools.get('memory_query')).toBeTruthy()
    expect((await call('discovery-at-unload')).isError).toBe(false)
    const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'memory')!
    await entry.update({ disabled: true })
    await ctx.loader.await()
    expect(ctx.tools.get('memory_query')).toBeUndefined()
    expect(agent.session.ownEvents().filter(event => pluginRecordOf(event)?.type === 'plugin:assessment-memory/receipt')).toHaveLength(3)
    await entry.update({ disabled: false })
    await ctx.loader.await()
    const restored = JSON.parse(await ctx.assessmentMemory.query(session, { view: 'observations' })) as { total: number }
    expect(restored.total).toBe(6)
  })

  it('latches invalid automatic intake and blocks later recorded execution', async () => {
    const { ctx, memory } = await composition()
    const driver = await mountAgentLoopTestHarness(ctx)
    const agent = await driver.create(session)
    await memory.begin(session, context)
    ctx.tools.register(defineTool({ name: 'recon_run', description: 'Invalid inventory fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => '{"bad":"inventory"}' }))
    const call = async (id: string) => ctx.tools.execute({ name: 'recon_run', arguments: {}, callId: ToolCallId(id),
      signal: new AbortController().signal, agent })
    await call('invalid')
    await Promise.resolve()
    expect((JSON.parse(await memory.status()) as { health: string }).health).toBe('degraded')
    expect((await call('blocked')).isError).toBe(true)
    expect((JSON.parse(await memory.status()) as { incompleteDispatches: number }).incompleteDispatches).toBeGreaterThan(0)
  })
})
