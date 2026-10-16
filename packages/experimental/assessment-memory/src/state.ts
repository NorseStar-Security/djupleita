/** Deterministic journal projection with optimistic revisions and evidence-backed transitions. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { assetIdentity, digest, normalize } from './identity.ts'
import type { AssetId, Assessment, AttemptContext, AssessmentCommand, Evidence, MemoryEvent, Observation, RecordId } from './schema.ts'
import { MemoryError } from './errors.ts'
import { emptyGraph, projectGraph, reconcileGraph, type GraphState } from './graph.ts'

export { MemoryError } from './errors.ts'
/** One immutable supported assertion about an asset. */
export interface Fact {
  id: RecordId
  assetId: AssetId
  observation: Observation
  evidenceId: RecordId
  observedAt: string
  recordedAt: string
  sequence: number
  assessmentId: string
}
/** A revisioned work item and its exclusive, expiring claim. */
export interface Task {
  id: string
  title: string
  reason: string
  assetIds: AssetId[]
  prerequisites: string[]
  priority: 'low' | 'medium' | 'high' | 'critical'
  retryWhen: string
  stopWhen: string
  revision: number
  status: 'pending' | 'running' | 'done' | 'blocked'
  owner?: string
  leaseUntil?: string
  assessmentId: string
}
type Revisioned<K extends AssessmentCommand['kind']> = Extract<AssessmentCommand,
  { kind: K }> & { revision: number; assessmentId: string; sessionId: string; updatedAt: string }
type Relation = Extract<AssessmentCommand, { kind: 'relate' }> & {
  id: RecordId
  assessmentId: string
  evidenceId: RecordId
  observedAt: string
  originalType?: string
}
/** Business state reconstructed exclusively from committed journal transactions. */
export interface MemoryState extends GraphState {
  assessments: Map<string, Assessment>
  bindings: Map<string, { assessmentId: string; context: AttemptContext }>
  facts: Map<RecordId, Fact>
  assetFacts: Map<AssetId, RecordId[]>
  retracted: Set<RecordId>
  relations: Map<RecordId, Relation>
  tasks: Map<string, Task>
  attempts: Map<string, Extract<AssessmentCommand,
    { kind: 'attempt' }> & { assessmentId: string; time: string; sequence: number; evidenceId: RecordId; assetSignatures: Record<string, string> }>
  findings: Map<string, Revisioned<'finding'>>
  artifacts: Map<string, Revisioned<'artifact'>>
  hypotheses: Map<string, Revisioned<'hypothesis'>>
  detections: Map<string, Extract<AssessmentCommand, { kind: 'detection' }> & { assessmentId: string }>
  handoffs: Map<string, Extract<AssessmentCommand, { kind: 'handoff' }> & { time: string; assessmentId: string }>
  dispatches: Map<string, { event: MemoryEvent; settled?: MemoryEvent }>
  evidence: Map<RecordId, Evidence>
}
/** Create an empty projection owned by one service instance.
 * @returns independent empty collections.
 */
export function emptyState(): MemoryState {
  return { ...emptyGraph(), assessments: new Map(), bindings: new Map(), facts: new Map(), assetFacts: new Map(), retracted: new Set(),
    relations: new Map(), tasks: new Map(), attempts: new Map(), findings: new Map(), artifacts: new Map(),
    hypotheses: new Map(), detections: new Map(), handoffs: new Map(), dispatches: new Map(), evidence: new Map() }
}

/** Derive current assets while preserving every historical observation separately.
 * @param state - committed business projection.
 * @returns current facts grouped by stable asset id, newest observations first.
 */
export function currentAssets(state: MemoryState): Map<AssetId, Fact[]> {
  const assets = new Map<AssetId, Fact[]>()
  for (const fact of state.facts.values()) {
    if (state.retracted.has(fact.id)) continue
    const facts = assets.get(fact.assetId) ?? []
    facts.push(fact); assets.set(fact.assetId, facts)
  }
  for (const facts of assets.values()) facts.sort((a,
    b) => Number(a.observation.basis === 'inferred') - Number(b.observation.basis === 'inferred') || b.observedAt.localeCompare(a.observedAt) || b.sequence - a.sequence || b.id.localeCompare(a.id))
  return assets
}

/** Group supported relationship assertions without losing their separate evidence.
 * @param state - committed business projection.
 * @returns stable structural relationship identities and their assertion histories.
 */
export function currentRelations(state: MemoryState): Map<string, Relation[]> {
  const groups = new Map<string, Relation[]>()
  for (const relation of state.relations.values()) {
    if (state.retracted.has(relation.id)) continue
    const key = digest([relation.source, relation.target, relation.relation, relation.originalType ?? null])
    const assertions = groups.get(key) ?? []
    assertions.unshift(relation)
    groups.set(key, assertions)
  }
  for (const assertions of groups.values()) assertions.sort((a,
    b) => Number(a.state === 'inferred') - Number(b.state === 'inferred') || b.observedAt.localeCompare(a.observedAt))
  return groups
}

/** Validate and apply one event to a private candidate; publish only after durable append.
 * @param state - disposable candidate projection.
 * @param event - next immutable transaction in sequence.
 * @param businessId - isolated namespace for asset identities.
 */
export function project(state: MemoryState, event: MemoryEvent, businessId: string): void {
  const payload = event.payload
  const references = (ids: readonly AssetId[]) => {
    if (ids.some(id => !state.assetFacts.get(id)?.some(fact => !state.retracted.has(fact)))) throw new MemoryError('MEMORY_REFERENCE', 'An asset reference is unavailable; query current assets first.')
  }
  if ('evidence' in payload) state.evidence.set(event.id, payload.evidence)
  const observe = (observation: Observation, index: number, evidence: Evidence) => {
    const normalized = normalize(observation)
    const assetId = assetIdentity(businessId, normalized)
    const id = brandString<RecordId>(`${event.id}:${index}`)
    const previous = [...(state.assetFacts.get(assetId) ?? [])].reverse()
      .map(id => state.facts.get(id)).find(fact => fact && !state.retracted.has(fact.id))
    const existing = previous !== undefined
    const changed = previous && digest(previous.observation) !== digest(normalized) && evidence.observedAt >= previous.observedAt
    state.facts.set(id, { id, assetId, observation: normalized, evidenceId: event.id,
      observedAt: evidence.observedAt, recordedAt: event.time,
      sequence: event.sequence, assessmentId: event.assessmentId })
    state.assetFacts.set(assetId, [...(state.assetFacts.get(assetId) ?? []), id])
    const taskId = `review:${assetId}`
    if (!existing && !state.tasks.has(taskId)) state.tasks.set(taskId, {
      id: taskId, title: `Review ${normalized.kind}: ${normalized.value}`,
      reason: 'New asset observation; establish ownership, relevance and applicable coverage before further work.',
      assetIds: [assetId], prerequisites: [], priority: 'medium',
      retryWhen: 'New evidence changes ownership or relevant service configuration.',
      stopWhen: 'Ownership and applicable coverage have been reviewed.',
      revision: 1, status: 'pending', assessmentId: event.assessmentId,
    })
    if (changed) {
      const changeId = `change:${digest([assetId, normalized])}`
      if (!state.tasks.has(changeId)) state.tasks.set(changeId, { id: changeId,
        title: `Review changed ${normalized.kind}: ${normalized.value}`,
        reason: 'New evidence changes a previously observed asset; reconsider applicable earlier work.', assetIds: [assetId],
        prerequisites: [], priority: 'high',
        retryWhen: 'The observed configuration changes again.',
        stopWhen: 'Affected assumptions and tests have been reviewed.', revision: 1, status: 'pending',
        assessmentId: event.assessmentId })
    }
    return assetId
  }
  const revision = (existing: { revision: number } | undefined, expected: number) => {
    if ((existing?.revision ?? 0) !== expected) throw new MemoryError('MEMORY_CONFLICT',
      'Record changed; query its current revision and retry deliberately.')
    return expected + 1
  }
  const settledAttempt = (attemptId: string) => {
    const attempt = state.attempts.get(attemptId)
    if (!attempt) throw new MemoryError('MEMORY_REFERENCE', 'Attempt is unavailable; record or query the supporting attempt first.')
    return attempt
  }
  switch (payload.kind) {
    case 'bind': {
      if (payload.assessment.businessId !== businessId || payload.assessment.id !== event.assessmentId) throw new MemoryError('MEMORY_CONFIG', 'Assessment does not belong to this business.')
      const existing = state.assessments.get(event.assessmentId)
      if (existing && digest(existing) !== digest(payload.assessment)) throw new MemoryError('MEMORY_CONFIG',
        'Assessment metadata changed; configure a new assessment id.')
      const previous = state.bindings.get(event.sessionId)
      if (previous && digest(previous) !== digest({ assessmentId: event.assessmentId,
        context: payload.context })) throw new MemoryError('MEMORY_BINDING',
        'This session is already bound to another assessment or access context; start a new session.')
      state.assessments.set(event.assessmentId, payload.assessment)
      state.bindings.set(event.sessionId, { assessmentId: event.assessmentId, context: payload.context })
      break
    }
    case 'capture': {
      const ids = payload.observations.map((observation, index) => observe(observation, index, payload.evidence))
      for (const [index, relation] of payload.relationships.entries()) {
        const source = ids[relation.sourceIndex], target = ids[relation.targetIndex]
        if (!source || !target) throw new MemoryError('MEMORY_REFERENCE', 'Imported relationship references a missing observation.')
        const id = brandString<RecordId>(`${event.id}:relation:${index}`)
        state.relations.set(id, { kind: 'relate', id, source, target, relation: relation.relation, state: 'inferred', confidence: 0,
          evidence: payload.evidence, evidenceId: event.id, observedAt: payload.evidence.observedAt, assessmentId: event.assessmentId,
          ...relation.originalType ? { originalType: relation.originalType } : {} })
      }
      break
    }
    case 'relate':
      references([payload.source, payload.target])
      state.relations.set(event.id, { ...payload, id: event.id, assessmentId: event.assessmentId, evidenceId: event.id,
        observedAt: payload.evidence.observedAt })
      break
    case 'retract':
      if (!state.facts.has(payload.observationId) && !state.relations.has(payload.observationId)) throw new MemoryError('MEMORY_REFERENCE', 'Observation or relationship is unavailable; query its exact id first.')
      state.retracted.add(payload.observationId)
      break
    case 'task': {
      references(payload.assetIds)
      if (payload.prerequisites.includes(payload.id) || payload.prerequisites.some(id => !state.tasks.has(id))) throw new MemoryError('MEMORY_REFERENCE', 'Task prerequisites must reference existing distinct tasks.')
      const existing = state.tasks.get(payload.id)
      if (existing?.status === 'running' && existing.leaseUntil && existing.leaseUntil > event.time) throw new MemoryError('MEMORY_CONFLICT', 'A claimed task cannot be edited until it is settled or its lease expires.')
      const reachable = (id: string, seen = new Set<string>()): boolean => {
        if (id === payload.id) return true
        if (seen.has(id)) return false
        seen.add(id)
        return state.tasks.get(id)?.prerequisites.some(next => reachable(next, seen)) ?? false
      }
      if (payload.prerequisites.some(id => reachable(id))) throw new MemoryError('MEMORY_REFERENCE',
        'Task prerequisites would create a cycle.')
      state.tasks.set(payload.id, { ...payload, revision: revision(existing, payload.expectedRevision), status: 'pending',
        assessmentId: event.assessmentId })
      break
    }
    case 'claim':
    case 'task-settle': {
      const task = state.tasks.get(payload.taskId)
      if (!task) throw new MemoryError('MEMORY_REFERENCE', 'Task unavailable; query tasks first.')
      const nextRevision = revision(task, payload.expectedRevision)
      if (payload.kind === 'claim') {
        if (task.status === 'done' || (task.status === 'running' && task.leaseUntil && task.leaseUntil > event.time)) throw new MemoryError('MEMORY_CONFLICT', 'Task is completed or has a live claim.')
        if (task.prerequisites.some(id => state.tasks.get(id)?.status !== 'done')) throw new MemoryError('MEMORY_CONFLICT',
          'Complete the task prerequisites before claiming it.')
        state.tasks.set(task.id, { ...task, status: 'running', owner: event.sessionId,
          leaseUntil: new Date(Date.parse(event.time) + event.claimLeaseMs).toISOString(), revision: nextRevision })
      } else {
        if (task.owner !== event.sessionId || task.status !== 'running' || !task.leaseUntil || task.leaseUntil <= event.time) throw new MemoryError('MEMORY_CONFLICT', 'Only the current unexpired claim owner can settle this task.')
        const { owner: _owner, leaseUntil: _leaseUntil, ...rest } = task
        state.tasks.set(task.id, { ...rest, status: payload.status, reason: payload.reason, revision: nextRevision })
      }
      break
    }
    case 'attempt':
      references(payload.assetIds)
      if (state.attempts.has(payload.id)) throw new MemoryError('MEMORY_CONFLICT',
        'Attempt ids are immutable; use a new id for another attempt.')
      if (payload.outcome !== 'completed' && payload.conclusion !== 'inconclusive') throw new MemoryError('MEMORY_REFERENCE',
        'Only completed attempts can support a confirmed or not-reproduced conclusion.')
      if (Date.parse(payload.applicableUntil) <= Date.parse(payload.evidence.observedAt)) throw new MemoryError('MEMORY_REFERENCE', 'Attempt applicability must end after its observation time.')
      state.attempts.set(payload.id, { ...payload, assessmentId: event.assessmentId, time: event.time, sequence: event.sequence,
        evidenceId: event.id,
        assetSignatures: Object.fromEntries(payload.assetIds.map(id => [id, assetSignature(state, id)])) })
      break
    case 'finding': {
      references(payload.assetIds)
      const existing = state.findings.get(payload.id)
      const nextRevision = revision(existing, payload.expectedRevision)
      if (payload.status === 'fix-verified') {
        if (!existing || !['open', 'remediation-reported',
          'reopened'].includes(existing.status) || !payload.verificationAttemptId) throw new MemoryError('MEMORY_REFERENCE',
          'Fix verification requires an existing finding and a supporting retest.')
        const attempt = settledAttempt(payload.verificationAttemptId)
        if (attempt.assessmentId !== event.assessmentId || attempt.outcome !== 'completed' || attempt.conclusion !== 'not-reproduced'
          || !payload.assetIds.every(id => attempt.assetIds.includes(id)) || attempt.time < existing.updatedAt) throw new MemoryError('MEMORY_REFERENCE', 'Fix verification requires a later completed retest covering the finding assets in this assessment.')
        if (digest([...payload.assetIds].sort()) !== digest([...existing.assetIds].sort())
          || Date.parse(attempt.applicableUntil) <= Date.parse(event.time)
          || attempt.assetIds.some(id => attempt.assetSignatures[id] !== assetSignature(state, id))
          || digest(attempt.context) !== digest(state.bindings.get(existing.sessionId)?.context)) throw new MemoryError('MEMORY_REFERENCE', 'Fix verification requires unchanged finding assets, a current retest with unchanged observations, and the original finding access context.')
      }
      if (payload.status === 'reopened' && existing?.status !== 'fix-verified') throw new MemoryError('MEMORY_REFERENCE',
        'Only a verified finding can be reopened.')
      state.findings.set(payload.id, { ...payload, revision: nextRevision, assessmentId: event.assessmentId,
        sessionId: event.sessionId, updatedAt: event.time })
      break
    }
    case 'artifact': {
      references(payload.assetIds)
      const existing = state.artifacts.get(payload.id)
      if (payload.status === 'cleanup-verified' && !existing) throw new MemoryError('MEMORY_REFERENCE',
        'Cleanup verification requires a previously recorded artifact.')
      state.artifacts.set(payload.id, { ...payload, revision: revision(existing, payload.expectedRevision),
        assessmentId: event.assessmentId, sessionId: event.sessionId, updatedAt: event.time })
      break
    }
    case 'hypothesis':
      references(payload.assetIds)
      if (payload.relationIds.some(id => !state.relations.has(id) || state.retracted.has(id))) throw new MemoryError('MEMORY_REFERENCE', 'Hypothesis references an unavailable relationship.')
      if (payload.status === 'validated' && (!payload.relationIds.length || payload.relationIds.some(id => state.relations.get(id)?.state !== 'validated'))) throw new MemoryError('MEMORY_REFERENCE', 'A validated hypothesis requires validated supporting relationships; inferred paths remain possible.')
      state.hypotheses.set(payload.id, { ...payload, revision: revision(state.hypotheses.get(payload.id),
        payload.expectedRevision), assessmentId: event.assessmentId, sessionId: event.sessionId, updatedAt: event.time })
      break
    case 'detection':
      settledAttempt(payload.attemptId)
      state.detections.set(payload.attemptId, { ...payload, assessmentId: event.assessmentId })
      break
    case 'handoff':
      state.handoffs.set(event.sessionId, { ...payload, time: event.time, assessmentId: event.assessmentId })
      break
    case 'dispatch': {
      const key = digest([event.sessionId, payload.callId])
      if (state.dispatches.has(key)) throw new MemoryError('MEMORY_CONFLICT', 'Tool dispatch already recorded.')
      state.dispatches.set(key, { event })
      break
    }
    case 'result': {
      const key = digest([event.sessionId, payload.callId])
      const existing = state.dispatches.get(key)
      if (existing?.settled) throw new MemoryError('MEMORY_CONFLICT', 'Tool outcome already recorded.')
      state.dispatches.set(key, { event: existing?.event ?? event, settled: event })
      payload.observations.forEach((observation, index) => observe(observation, index, payload.evidence))
      for (const [index, relation] of payload.relationships.entries()) {
        const source = assetIdentity(businessId, normalize(relation.source))
        const target = assetIdentity(businessId, normalize(relation.target))
        references([source, target])
        const id = brandString<RecordId>(`${event.id}:relation:${index}`)
        state.relations.set(id, { kind: 'relate', id, source, target, relation: relation.relation, state: 'observed',
          confidence: 1, evidence: payload.evidence, evidenceId: event.id, observedAt: payload.evidence.observedAt,
          assessmentId: event.assessmentId })
      }
      break
    }
    case 'objective':
    case 'capability':
    case 'path':
    case 'coverage-plan':
      projectGraph(state, event)
      break
  }
  reconcileGraph(state, event)
}

/** Fingerprint currently supported assertions for conservative attempt invalidation.
 * @param state - current committed projection.
 * @param id - asset whose observation history is examined.
 * @returns canonical digest of its newest supported observation, or missing marker.
 */
export function assetSignature(state: MemoryState, id: AssetId): string {
  const facts = (state.assetFacts.get(id) ?? []).map(id => state.facts.get(id))
    .filter((fact): fact is Fact => fact !== undefined && !state.retracted.has(fact.id))
  facts.sort((a, b) => Number(a.observation.basis === 'inferred') - Number(b.observation.basis === 'inferred') || b.observedAt.localeCompare(a.observedAt) || b.sequence - a.sequence || b.id.localeCompare(a.id))
  return digest(facts[0]?.observation ?? null)
}
