import { it, expect } from 'vitest';
import { AttackGraph, graphId } from '../packages/graph/src/index.ts';
import { digest, id } from '../packages/contracts/src/index.ts';
import type { Evidence } from '../packages/contracts/src/index.ts';

it('preserves evidence-backed identity relationships through RAGE export and import', () => {
  const engagementId = id<'EngagementId'>();
  const graph = new AttackGraph(':memory:', engagementId), restored = new AttackGraph(':memory:', engagementId);
  try {
    const evidence: Evidence = { id: id<'EvidenceId'>(), contentHash: digest({ status: 200 }), pointer: 'blobs/hash',
      mediaType: 'application/json', tool: 'authz_compare', observedAt: new Date().toISOString() };
    graph.addEvidence(evidence);
    const a = graphId(engagementId, 'identity', 'alice|1'), b = graphId(engagementId, 'object', 'record%1');
    for (const nodeId of [a, b]) graph.putNode({ id: nodeId, type: 'Resource', name: nodeId,
      attributes: {}, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    graph.putEdge({ id: 'access', source: a, target: b, type: 'CanRead', status: 'verified',
      attributes: {}, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    const bundle = graph.exportRage();
    expect(bundle.split('\n')[0]).toContain('"spec_version":"0.1"');
    restored.importRage(bundle);
    expect(restored.snapshot()).toEqual(graph.snapshot());
    expect(restored.paths(a, b, 3)).toHaveLength(1);
  } finally { graph.close(); restored.close(); }
});
it('does not turn hypotheses into verified attack paths and rolls back invalid graph imports', () => {
  const graph = new AttackGraph(':memory:', id<'EngagementId'>());
  try {
    const bad = [{ kind: 'manifest', spec_version: '0.1' }, { kind: 'node', node_id: 'one', node_type: 'Resource' },
      { kind: 'edge', source: 'one', target: 'missing', type: 'CanRead', evidence: ['missing'] }].map(value => JSON.stringify(value)).join('\n');
    expect(() => graph.importRage(bad)).toThrow();
    expect(graph.snapshot()).toEqual({ nodes: [], edges: [], evidence: [] });
  } finally { graph.close(); }
});

it('pages graph nodes with exact totals and only relationships among displayed nodes', () => {
  const graph = new AttackGraph(':memory:', id<'EngagementId'>());
  try {
    const evidence: Evidence = { id: id<'EvidenceId'>(), contentHash: digest({ test: 1 }), pointer: 'blobs/hash',
      mediaType: 'application/json', tool: 'fixture', observedAt: new Date().toISOString() };
    graph.addEvidence(evidence);
    for (let i = 0; i < 310; i++) graph.putNode({ id: `node-${String(i).padStart(3, '0')}`, type: 'Resource', name: String(i), attributes: {}, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    for (let i = 1; i < 310; i++) graph.putEdge({ id: `edge-${i}`, source: 'node-000', target: `node-${String(i).padStart(3, '0')}`, type: 'References', status: 'observed', attributes: {}, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    const first = graph.page(); expect(first.nodes).toHaveLength(150); expect(first.edges).toHaveLength(149);
    expect(first.counts).toEqual({ nodes: 310, edges: 309, evidence: 1 }); expect(first.nextOffset).toBe(150);
    const second = graph.page(150); expect(second.nodes).toHaveLength(150); expect(second.edges).toHaveLength(0);
    expect(graph.page(300).nodes).toHaveLength(10); expect(graph.page(300).nextOffset).toBeNull();
    expect(() => graph.page(-1)).toThrow('Invalid'); expect(graph.snapshot().nodes).toHaveLength(310);
  } finally { graph.close(); }
});
