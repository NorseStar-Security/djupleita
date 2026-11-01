/** Persistent evidence graph and RAGE 0.1 interchange. */
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { PentestError, canonical, digest } from '@dsh-pentest/contracts';
import type { EngagementId, Evidence, Json } from '@dsh-pentest/contracts';

const EvidenceSchema = z.object({ id: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), pointer: z.string(),
  mediaType: z.string(), tool: z.string(), observedAt: z.iso.datetime(), identityId: z.string().optional() });
export const NodeSchema = z.object({
  id: z.string().min(1), type: z.string().min(1), name: z.string(), attributes: z.record(z.string(), z.json()),
  evidenceIds: z.array(z.string()), observedAt: z.iso.datetime(),
});
export const EdgeSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), target: z.string().min(1), type: z.string().min(1),
  status: z.enum(['observed', 'inferred', 'verified']), evidenceIds: z.array(z.string()).min(1),
  attributes: z.record(z.string(), z.json()), observedAt: z.iso.datetime(),
});
export type GraphNode = z.infer<typeof NodeSchema>;
export type GraphEdge = z.infer<typeof EdgeSchema>;
export interface GraphSnapshot { nodes: GraphNode[]; edges: GraphEdge[]; evidence: Evidence[] }

/** Node IDs preserve RAGE's four-component identity grammar. */
export function graphId(realm: string, type: string, nativeId: string): string {
  const escape = (part: string) => part.replaceAll('%', '%25').replaceAll('|', '%7C');
  return ['dsh', realm, type, nativeId].map(escape).join('|');
}

export class AttackGraph {
  private readonly db: DatabaseSync;
  constructor(path: string, readonly engagementId: EngagementId) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES nodes(id),
        target TEXT NOT NULL REFERENCES nodes(id), body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS edges_source ON edges(source);
      CREATE INDEX IF NOT EXISTS edges_target ON edges(target);
    `);
    const existing = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('engagement');
    if (existing && existing.value !== engagementId) { this.db.close(); throw new PentestError('GRAPH_ENGAGEMENT', 'Graph belongs to a different engagement'); }
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('engagement', engagementId);
  }

  addEvidence(evidence: Evidence): void {
    EvidenceSchema.parse(evidence);
    const prior = this.db.prepare('SELECT body FROM evidence WHERE id=?').get(evidence.id);
    if (prior && prior.body !== canonical(evidence)) throw new PentestError('EVIDENCE_CONFLICT', 'Evidence identifier refers to different content');
    this.db.prepare('INSERT OR IGNORE INTO evidence VALUES (?,?)').run(evidence.id, canonical(evidence));
  }

  putNode(node: GraphNode): void {
    NodeSchema.parse(node);
    this.requireEvidence(node.evidenceIds);
    this.db.prepare('INSERT INTO nodes VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(node.id, canonical(node));
  }

  putEdge(edge: GraphEdge): void {
    EdgeSchema.parse(edge);
    this.requireEvidence(edge.evidenceIds);
    if (!this.getNode(edge.source) || !this.getNode(edge.target)) throw new PentestError('GRAPH_REFERENCE', 'Edge endpoints must exist');
    this.db.prepare('INSERT INTO edges VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source,target=excluded.target,body=excluded.body')
      .run(edge.id, edge.source, edge.target, canonical(edge));
  }

  getNode(nodeId: string): GraphNode | undefined {
    const row = this.db.prepare('SELECT body FROM nodes WHERE id=?').get(nodeId);
    return row ? NodeSchema.parse(JSON.parse(String(row.body))) : undefined;
  }

  snapshot(): GraphSnapshot {
    return {
      nodes: this.db.prepare('SELECT body FROM nodes ORDER BY id').all().map(row => NodeSchema.parse(JSON.parse(String(row.body)))),
      edges: this.db.prepare('SELECT body FROM edges ORDER BY id').all().map(row => EdgeSchema.parse(JSON.parse(String(row.body)))),
      evidence: this.db.prepare('SELECT body FROM evidence ORDER BY id').all().map(row => JSON.parse(String(row.body)) as Evidence),
    };
  }

  /** Counts do not materialize graph bodies or evidence in the UI/agent status path. */
  counts(): { nodes: number; edges: number; evidence: number } {
    return Object.fromEntries(['nodes', 'edges', 'evidence'].map(table => [table,
      Number(this.db.prepare(`SELECT count(*) AS total FROM ${table}`).get()!.total)])) as { nodes: number; edges: number; evidence: number };
  }

  /** A bounded node page and at most 500 relationships among its displayed nodes. */
  page(offset = 0, limit = 150): { nodes: GraphNode[]; edges: GraphEdge[]; counts: ReturnType<AttackGraph['counts']>; offset: number; nextOffset: number | null } {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 150) throw new PentestError('GRAPH_PAGE', 'Invalid graph page');
    const counts = this.counts();
    const nodes = this.db.prepare('SELECT body FROM nodes ORDER BY id LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => NodeSchema.parse(JSON.parse(String(row.body))));
    const ids = nodes.map(node => node.id), slots = ids.map(() => '?').join(',');
    const edges = ids.length ? this.db.prepare(`SELECT body FROM edges WHERE source IN (${slots}) AND target IN (${slots}) ORDER BY id LIMIT 500`)
      .all(...ids, ...ids).map(row => EdgeSchema.parse(JSON.parse(String(row.body)))) : [];
    return { nodes, edges, counts, offset, nextOffset: offset + nodes.length < counts.nodes ? offset + nodes.length : null };
  }

  /** Traversal excludes inferred capabilities unless the caller requests hypotheses. */
  paths(source: string, target: string, maxDepth: number, includeInferred = false): GraphEdge[][] {
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 32) throw new PentestError('GRAPH_DEPTH', 'Path depth must be between 0 and 32');
    const result: GraphEdge[][] = [];
    const visit = (node: string, path: GraphEdge[], visited: Set<string>) => {
      if (node === target) { result.push(path); return; }
      if (path.length >= maxDepth || result.length >= 1000) return;
      const outgoing = this.db.prepare('SELECT body FROM edges WHERE source=? ORDER BY id').all(node);
      for (const row of outgoing) {
        const edge = EdgeSchema.parse(JSON.parse(String(row.body)));
        if (!includeInferred && edge.status === 'inferred' || visited.has(edge.target) || edge.attributes.walkable === false
          || edge.attributes.rageState === 'BLOCKED') continue;
        visit(edge.target, [...path, edge], new Set([...visited, edge.target]));
      }
    };
    visit(source, [], new Set([source]));
    return result;
  }

  exportRage(): string {
    const data = this.snapshot();
    const records: Json[] = [{ kind: 'manifest', spec_version: '0.1', media_type: 'application/vnd.rage.graph+ndjson',
      producer: { name: 'dsh-pentest', version: '0.1.0' }, counts: { nodes: data.nodes.length, edges: data.edges.length, findings: 0 },
      'x-dsh': { engagementId: this.engagementId } }];
    for (const evidence of data.evidence) records.push({ kind: 'evidence', evidence_id: evidence.id, content_hash: evidence.contentHash,
      source: evidence.tool, pointer: evidence.pointer, captured_at: evidence.observedAt, status: 'ok', 'x-dsh': { ...evidence } });
    for (const node of data.nodes) records.push({ kind: 'node', node_id: node.id, node_type: node.type, name: node.name,
      observed_at: node.observedAt, attributes: { 'x-dsh': { attributes: node.attributes, evidenceIds: node.evidenceIds } } });
    for (const edge of data.edges) {
      const factId = `fact:${edge.id}`;
      records.push({ kind: 'fact', fact_id: factId, source: edge.source, target: edge.target, captured_at: edge.observedAt, evidence: edge.evidenceIds });
      records.push({ kind: 'edge', edge_id: edge.id, source: edge.source, target: edge.target, type: edge.type,
        state: edge.status === 'inferred' ? 'UNKNOWN' : 'ACTIVE', nature: edge.status === 'inferred' ? 'derived' : 'explicit',
        facts: [factId], evidence: edge.evidenceIds, 'x-dsh': { status: edge.status, attributes: edge.attributes, observedAt: edge.observedAt } });
    }
    return `${records.map(canonical).join('\n')}\n`;
  }

  /** Validate known records and references, then import atomically; future kinds are skipped. */
  importRage(source: string): void {
    const records = source.split('\n').filter(Boolean).map(line => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
    const manifest = records[0];
    if (manifest?.kind !== 'manifest' || manifest.spec_version !== '0.1') throw new PentestError('RAGE_VERSION', 'Expected a RAGE 0.1 manifest on the first line');
    if (records.slice(1).some(record => record.kind === 'manifest')) throw new PentestError('RAGE_MANIFEST', 'RAGE contains more than one manifest');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const record of records) {
        if (record.kind !== 'evidence') continue;
        const parsed = z.object({ evidence_id: z.string(), content_hash: z.string().regex(/^[a-f0-9]{64}$/),
          source: z.string().optional(), pointer: z.string().optional(), captured_at: z.iso.datetime().optional() }).parse(record);
        const extension = EvidenceSchema.safeParse(record['x-dsh']);
        this.addEvidence(extension.success ? extension.data as Evidence : { id: parsed.evidence_id as Evidence['id'], contentHash: parsed.content_hash,
          pointer: parsed.pointer ?? '', tool: parsed.source ?? 'rage-import', mediaType: 'application/json',
          observedAt: parsed.captured_at ?? new Date(0).toISOString() });
      }
      for (const record of records) {
        if (record.kind !== 'node') continue;
        const parsed = z.object({ node_id: z.string(), node_type: z.string(), name: z.string().optional(), observed_at: z.iso.datetime().optional(),
          attributes: z.record(z.string(), z.json()).optional() }).parse(record);
        const extension = z.object({ attributes: z.record(z.string(), z.json()), evidenceIds: z.array(z.string()) }).safeParse(parsed.attributes?.['x-dsh']);
        this.putNode({ id: parsed.node_id, type: parsed.node_type, name: parsed.name ?? parsed.node_id,
          attributes: extension.success ? extension.data.attributes : parsed.attributes ?? {},
          evidenceIds: extension.success ? extension.data.evidenceIds : [], observedAt: parsed.observed_at ?? new Date(0).toISOString() });
      }
      const facts = new Map(records.filter(record => record.kind === 'fact').map(record => [z.string().parse(record.fact_id), record]));
      for (const record of records) {
        if (record.kind !== 'edge') continue;
        const parsed = z.object({ edge_id: z.string().optional(), source: z.string(), target: z.string(), type: z.string(),
          nature: z.enum(['explicit', 'derived']).optional(), evidence: z.union([z.string(), z.array(z.string())]).optional(),
          facts: z.array(z.string()).optional(), state: z.string().optional() }).parse(record);
        const refs = typeof parsed.evidence === 'string' ? [parsed.evidence] : parsed.evidence ?? [];
        for (const ref of parsed.facts ?? []) {
          const fact = facts.get(ref);
          if (!fact) throw new PentestError('RAGE_REFERENCE', 'Edge refers to an unknown fact');
          const evidence = z.union([z.string(), z.array(z.string())]).optional().parse(fact.evidence);
          refs.push(...typeof evidence === 'string' ? [evidence] : evidence ?? []);
        }
        if (refs.length === 0) throw new PentestError('RAGE_EVIDENCE', 'Imported edges require supporting evidence');
        const extension = z.object({ status: EdgeSchema.shape.status, attributes: z.record(z.string(), z.json()), observedAt: z.iso.datetime() }).safeParse(record['x-dsh']);
        this.putEdge({ id: parsed.edge_id ?? digest(parsed), source: parsed.source, target: parsed.target, type: parsed.type,
          status: extension.success ? extension.data.status : parsed.state === 'ACTIVE' && parsed.nature !== 'derived' ? 'observed' : 'inferred',
          evidenceIds: [...new Set(refs)], attributes: extension.success ? extension.data.attributes : { rageState: parsed.state ?? 'ACTIVE' },
          observedAt: extension.success ? extension.data.observedAt : new Date(0).toISOString() });
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close(): void { this.db.close(); }
  private requireEvidence(ids: string[]): void {
    const exists = this.db.prepare('SELECT id FROM evidence WHERE id=?');
    for (const evidenceId of ids) if (!exists.get(evidenceId)) throw new PentestError('GRAPH_EVIDENCE', 'Graph refers to missing evidence');
  }
}
