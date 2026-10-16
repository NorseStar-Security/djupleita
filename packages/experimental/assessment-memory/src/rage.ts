/** RAGE v0.1 exchange adapter. Original implementation against https://rage.fail/format. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { currentAssets, currentRelations, MemoryError, type MemoryState } from './state.ts'
import { digest } from './identity.ts'
import type { AssetId, AssessmentCommand } from './schema.ts'

const attribution = { project: 'RAGE — Relational Attack Graph Exchange', url: 'https://rage.fail/',
  specification: 'https://rage.fail/format',
  notice: 'RAGE format integration; original harness implementation. No RAGE source code or rule corpus is bundled. No endorsement is implied.' }
function component(value: string): string { return value.replace(/%/g, '%25').replace(/\|/g, '%7C') }

/** Export current asset assertions and non-walkable relationships with evidence links.
 * @param businessId - business namespace used for exported node realms.
 * @param state - committed business projection.
 * @returns complete RAGE v0.1 NDJSON with manifest first and explicit extension metadata.
 */
export function exportRage(businessId: string, state: MemoryState): string {
  const records: object[] = []
  const ids = new Map<AssetId, string>()
  const emittedNodes = new Set<string>()
  const assets = currentAssets(state)
  for (const [id, facts] of assets) {
    const fact = facts[0]
    if (!fact) continue
    const observation = fact.observation
    const nativeId = observation.kind === 'service' ? `${observation.value}:${observation.port}` : observation.value
    const nativeIdentity = observation.identity
    const nodeId = typeof observation.attributes.rageNodeId === 'string' ? observation.attributes.rageNodeId : (nativeIdentity
      ? [nativeIdentity.provider, nativeIdentity.realm, nativeIdentity.nativeType, nativeIdentity.nativeId]
      : ['assessment', businessId, observation.kind, nativeId]).map(component).join('|')
    ids.set(id, nodeId)
    if (!emittedNodes.has(nodeId)) records.push({ kind: 'node', node_id: nodeId,
      node_type: typeof observation.attributes.rageNodeType === 'string' ? observation.attributes.rageNodeType : `x-assessment:${observation.kind}`,
      name: observation.value, observed_at: fact.observedAt, attributes: { ...observation.attributes,
        'x-assessment': { asset_id: id, basis: observation.basis, confidence: observation.confidence, permission: 'none',
          observation_ids: facts.map(item => item.id) } } })
    emittedNodes.add(nodeId)
    for (const item of facts) records.push({ kind: 'fact', fact_id: item.id, target: nodeId, captured_at: item.observedAt,
      evidence: item.evidenceId,
      attributes: { 'x-assessment': { ...item.observation, assessment_id: item.assessmentId } } })
  }
  for (const [id, evidence] of state.evidence) records.push({ kind: 'evidence', evidence_id: id, content_hash: evidence.contentHash,
    source: evidence.source, captured_at: evidence.observedAt, pointer: evidence.locator, detail: { summary: evidence.summary } })
  for (const [relationshipId, assertions] of currentRelations(state)) {
    const relation = assertions[0]
    if (!relation) continue
    const source = ids.get(relation.source), target = ids.get(relation.target)
    if (!source || !target) continue
    const nature = relation.state === 'inferred' ? 'derived' : 'explicit'
    const factId = `${relation.id}:support`
    records.push({ kind: 'fact', fact_id: factId, source, target, edge_hint: relation.relation,
      evidence: relation.evidenceId, captured_at: relation.observedAt })
    records.push({ kind: 'edge', edge_id: relationshipId, source, target, type: relation.relation,
      nature, state: relation.state === 'blocked' ? 'BLOCKED' : relation.state === 'inferred' ? 'UNKNOWN' : 'ACTIVE',
      facts: [factId], evidence: relation.evidenceId, confidence: relation.confidence,
      'x-assessment': { walkable: false, validation: relation.state,
        assertion_ids: assertions.map(assertion => assertion.id), original_type: relation.originalType ?? null,
        assessment_id: relation.assessmentId } })
  }
  const manifest = { kind: 'manifest', spec_version: '0.1', media_type: 'application/vnd.rage.graph+ndjson',
    created_at: new Date().toISOString(),
    producer: { name: '@deepseek-ai/dsh-experimental-assessment-memory', version: '0.2.1-alpha.3' },
    scope: { providers: [...new Set(['assessment', ...[...emittedNodes].map(id => id.split('|')[0])])].sort(), 'x-assessment-business': businessId },
    counts: { nodes: emittedNodes.size, edges: records.filter(record => 'kind' in record && record.kind === 'edge').length, findings: 0 },
    'x-assessment': { attribution, custom_relationships: 'structural; never traverse as attacker capabilities',
      operational_history: 'retained in assessment journal; excluded from graph exchange',
      capability_analysis: 'objectives, capabilities, paths and coverage plans remain in the assessment journal; not emitted as standard RAGE access edges' } }
  return [manifest, ...records].map(record => JSON.stringify(record)).join('\n') + '\n'
}

const node = z.object({ kind: z.literal('node'), node_id: z.string().min(1).max(4096),
  node_type: z.string().min(1).max(4096), name: z.string().max(4096).optional() }).loose()
const edge = z.object({ kind: z.literal('edge'), source: z.string(), target: z.string(), type: z.string().min(1).max(4096),
  nature: z.enum(['explicit', 'derived']).optional(), evidence: z.union([z.string(), z.array(z.string()).min(1)]).optional() }).loose()

/** Validate a supported RAGE bundle and convert it to an untrusted capture transaction.
 * @param graph - complete NDJSON; unsupported record kinds are ignored per the format.
 * @returns one atomic capture with preserved native ids and inferred imported relationships.
 */
export function importRage(graph: string): Extract<AssessmentCommand, { kind: 'capture' }> {
  const lines = graph.split('\n').filter(line => line.trim())
  const manifest = z.object({ kind: z.literal('manifest'), spec_version: z.literal('0.1'),
    created_at: z.iso.datetime().optional() }).loose().parse(JSON.parse(lines.shift() ?? 'null'))
  const nodes: z.infer<typeof node>[] = [], edges: z.infer<typeof edge>[] = []
  for (const line of lines) {
    const raw: unknown = JSON.parse(line)
    const kind = z.object({ kind: z.string() }).loose().parse(raw).kind
    if (kind === 'manifest') throw new MemoryError('MEMORY_REFERENCE', 'RAGE import permits exactly one leading manifest.')
    if (kind === 'node') {
      const parsed = node.parse(raw)
      const parts = parsed.node_id.split('|')
      if (parts.length !== 4 || parts.some(part => !part) || !/^[a-z][a-z0-9-]*$/.test(parts[0] ?? '') || /%(?!25|7C)/.test(parsed.node_id)) throw new MemoryError('MEMORY_REFERENCE', 'RAGE node ids must use four escaped provider|account|native_type|native_id components.')
      nodes.push(parsed)
    } else if (kind === 'edge') edges.push(edge.parse(raw))
    else if (kind === 'fact') z.object({ fact_id: z.string().min(1) }).loose().parse(raw)
    else if (kind === 'evidence') z.object({ evidence_id: z.string().min(1), content_hash: z.string().min(1) }).loose().parse(raw)
    else if (kind === 'finding') z.object({ resource_id: z.string().min(1), severity: z.enum(['low', 'medium', 'high',
      'critical']) }).loose().parse(raw)
  }
  if (!nodes.length || nodes.length > 10000 || edges.length > 10000) throw new MemoryError('MEMORY_LIMIT',
    'RAGE import needs 1–10000 nodes and at most 10000 edges.')
  const indices = new Map(nodes.map((value, index) => [value.node_id, index]))
  if (indices.size !== nodes.length) throw new MemoryError('MEMORY_REFERENCE', 'RAGE import contains duplicate node ids.')
  const relationships = edges.map((value) => {
    const sourceIndex = indices.get(value.source), targetIndex = indices.get(value.target)
    if (sourceIndex === undefined || targetIndex === undefined) throw new MemoryError('MEMORY_REFERENCE',
      'RAGE edge references a node absent from this bundle.')
    if (value.nature === 'derived' && !value.evidence) throw new MemoryError('MEMORY_REFERENCE',
      'A derived RAGE edge requires an evidence reference.')
    return { sourceIndex, targetIndex, relation: 'x-assessment:ImportedRelationship', originalType: value.type }
  })
  return { kind: 'capture', coverage: 'partial', relationships,
    evidence: { source: 'RAGE import', locator: `rage-import:${digest(graph)}`,
      contentHash: createHash('sha256').update(graph).digest('hex'),
      observedAt: manifest.created_at ?? '1970-01-01T00:00:00.000Z',
      summary: `Untrusted RAGE ${manifest.spec_version} bundle: ${nodes.length} nodes, ${edges.length} relationships. Imported relationships are hypotheses and confer no permissions.` },
    observations: nodes.map(value => ({ kind: 'resource', value: value.node_id,
      attributes: { rageNodeId: value.node_id, rageNodeType: value.node_type,
        ...(value.name ? { importedName: value.name } : {}) }, confidence: 0, basis: 'inferred' })) }
}
