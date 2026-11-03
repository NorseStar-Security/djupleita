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

it('searches all collections and follows relationships across node pages with bounded evidence', () => {
  const graph = new AttackGraph(':memory:', id<'EngagementId'>());
  try {
    const evidence = (tool: string): Evidence => ({ id: id<'EvidenceId'>(), contentHash: digest(tool), pointer: `blobs/${digest(tool)}`,
      mediaType: 'application/json', tool, observedAt: new Date().toISOString() });
    const recon = evidence('subfinder'), probe = evidence('httpx');
    graph.addEvidence(recon); graph.addEvidence(probe);
    const target = 'target';
    graph.putNode({ id: target, type: 'ReconTarget', name: 'example.test', attributes: {}, evidenceIds: [recon.id], observedAt: recon.observedAt });
    for (let i = 0; i < 205; i++) {
      const nodeId = `host-${String(i).padStart(3, '0')}`;
      graph.putNode({ id: nodeId, type: 'Host', name: `${i}.example.test`, attributes: {}, evidenceIds: [i === 204 ? probe.id : recon.id], observedAt: recon.observedAt });
      graph.putEdge({ id: `edge-${nodeId}`, source: target, target: nodeId, type: 'Discovered', status: i === 204 ? 'inferred' : 'observed',
        evidenceIds: [recon.id], attributes: {}, observedAt: recon.observedAt });
    }
    expect(graph.explore().nodes[0]?.id).toBe(target);
    expect(graph.explore().nextOffset).toBe(100);
    expect(graph.explore('', 'Host', '', 200).nodes).toHaveLength(5);
    const search = graph.explore('204.EXAMPLE.TEST', 'Host', 'httpx');
    expect(search.nodes.map(node => node.id)).toEqual(['host-204']);
    expect(search.collections).toEqual([{ name: 'httpx', count: 1 }, { name: 'subfinder', count: 1 }]);
    expect(graph.explore('', '', 'subfinder').total).toBe(206); // Relationship evidence survives a later node update from another tool.
    expect(graph.explore('%').total).toBe(0); // Search characters are literal, never SQL wildcards.
    expect(graph.explore("' OR 1=1 --").total).toBe(0);
    const first = graph.neighborhood(target);
    expect(first.edges).toHaveLength(30); expect(first.total).toBe(205); expect(first.nextOffset).toBe(30);
    expect(graph.neighborhood(target, 180).edges).toHaveLength(25);
    expect(graph.neighborhood(target, 180).nextOffset).toBeNull();
    const reverse = graph.neighborhood('host-204');
    expect(reverse.nodes.map(node => node.id)).toEqual([target]);
    expect(reverse.edges[0]?.status).toBe('inferred');
    expect(new Set(reverse.evidence.map(item => item.tool))).toEqual(new Set(['subfinder', 'httpx']));
    expect(() => graph.neighborhood('missing')).toThrow('no longer exists');
    expect(() => graph.neighborhood(target, -1)).toThrow('Invalid');
    expect(() => graph.explore('x'.repeat(301))).toThrow('Invalid');
  } finally { graph.close(); }
});
