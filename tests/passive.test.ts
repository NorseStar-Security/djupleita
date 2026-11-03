import { it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassiveReconService } from '../packages/recon/src/passive.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { AttackGraph } from '../packages/graph/src/index.ts';
import { Redactor, TrajectoryStore, EvidenceStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement } from './fixtures.ts';

it('preserves passive provenance, strips credential samples and never grants scope to associated domains', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-passive-')), config = engagement(), redactor = new Redactor();
  config.scope.exclusions = ['excluded.example.test'];
  const graph = new AttackGraph(':memory:', config.id), sessions = new EngagementService(config), session = id<'SessionId'>(); sessions.attach(session);
  const scopes = new ScopeService(config.scope), store = new TrajectoryStore(join(root, 'events'), config.id, redactor), evidence = new EvidenceStore(root, redactor);
  const calls: string[] = [], accessKinds: (string | undefined)[] = [], candidates: string[] = [];
  const service = new PassiveReconService({ dohEndpoint: 'https://dns.google/resolve', pdcpIdentityId: id<'IdentityId'>() }, scopes, sessions,
    async (url, _signal, _identity, access) => { calls.push(url); accessKinds.push(access); return url.includes('/associated') ? { results: [{ domain: 'outside.invalid' }] } : { total_leaks: 4, employees_sample_data: [{ password: 'breached-secret' }] }; },
    graph, evidence, store, redactor, () => ({ observe(urls: string[]) { candidates.push(...urls); return urls.filter(url => { try { scopes.check({ url, purpose: 'target' }); return true; } catch { return false; } }).length; } }) as never);
  try {
    const result = await service.run({ operation: 'associated-domains', domain: 'app.example.test', page: 1 }, session, new AbortController().signal) as Record<string, unknown>;
    expect(result.queued).toBe(0); expect(candidates).toContain('https://outside.invalid/'); expect(graph.paths(graph.snapshot().nodes[0]!.id, 'outside.invalid', 3)).toEqual([]);
    const exposure = await service.run({ operation: 'breach-exposure', domain: 'app.example.test', page: 1 }, session, new AbortController().signal);
    expect(JSON.stringify(exposure)).toContain('total_leaks'); expect(JSON.stringify(exposure)).not.toContain('breached-secret');
    await expect(service.run({ operation: 'dns', domain: 'excluded.example.test', page: 1 }, session, new AbortController().signal)).rejects.toThrow('Excluded');
    await service.run({ operation: 'dns', domain: 'research.example.test', page: 1 }, session, new AbortController().signal);
    expect(accessKinds).toEqual(['service', 'service', ...Array(7).fill('research')]);
    expect(calls).toHaveLength(9); expect(sessions.snapshot().requests).toBe(9);
    expect(graph.snapshot().edges.every(edge => edge.attributes.walkable === false)).toBe(true);
  } finally { graph.close(); }
});
