import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ReconService, reconInputs } from '../packages/recon/src/index.ts';
import { AttackGraph } from '../packages/graph/src/index.ts';
import { lab } from './http-lab.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { engagement, scope } from './fixtures.ts';

it('accepts explicit httpx arrays and rejects ambiguous or unsupported batch requests', () => {
  expect(reconInputs({ tool: 'httpx', targets: ['https://a.example.test/', 'https://a.example.test/', 'https://b.example.test/'], rate: 1, concurrency: 1 })).toHaveLength(2);
  for (const request of [{ tool: 'httpx' }, { tool: 'httpx', targets: [] },
    { tool: 'httpx', target: 'https://a.example.test/', targets: ['https://b.example.test/'] },
    { tool: 'subfinder', targets: ['https://a.example.test/'] }]) expect(() => reconInputs(request)).toThrow();
});
it('validates every batch destination and line boundary before launching any worker', async () => {
  const config = engagement({ scope: scope('allowed.example.test') });
  const root = await mkdtemp(join(tmpdir(), 'djupleita-batch-preflight-'));
  const service = new ReconService({ binaries: {}, sources: ['crtsh'], timeoutMs: 1000 }, root, new ScopeService(config.scope),
    new EngagementService(config), undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
  try {
    const input = { tool: 'httpx' as const, target: 'https://allowed.example.test/', depth: 1 };
    await expect(service.runBatch([input, { ...input, target: 'https://outside.example.test/' }], 'fixture' as never, AbortSignal.timeout(5000))).rejects.toThrow('outside');
    await expect(service.runBatch([input, { ...input, target: 'https://allowed.example.test/\nhttps://outside.example.test/' }], 'fixture' as never, AbortSignal.timeout(5000))).rejects.toThrow('one exact');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.skipIf(!process.env.DSH_TEST_RECON_CONFIG)('runs a real confined httpx batch against local fixtures with one retained evidence record', async () => {
  const fixture = await lab(); const root = await mkdtemp(join(tmpdir(), 'djupleita-httpx-batch-'));
  const graph = new AttackGraph(':memory:', fixture.config.id);
  const tooling = JSON.parse(await readFile(process.env.DSH_TEST_RECON_CONFIG!, 'utf8'));
  const service = new ReconService({ binaries: tooling.recon.binaries, sources: ['crtsh'], timeoutMs: 20000 }, root, fixture.scopes,
    fixture.sessions, graph, fixture.evidence, fixture.trajectories, fixture.redactor, () => ({ observe() { return 0; } }) as never);
  try {
    const inputs = reconInputs({ tool: 'httpx', targets: [`${fixture.url}/one`, `${fixture.url}/two`], rate: 2, concurrency: 1 });
    const result = await service.runBatch(inputs, fixture.sessionId, AbortSignal.timeout(25000)) as { recordCount: number; targetCount: number; records: { url: string; status_code: number }[]; exitCode: number };
    expect(result).toMatchObject({ recordCount: 2, targetCount: 2, exitCode: 0 });
    expect(result.records.map(record => record.url).sort()).toEqual(inputs.map(input => input.target).sort());
    expect(result.records.every(record => record.status_code === 200)).toBe(true);
    expect((await fixture.trajectories.read(fixture.sessionId)).filter(event => event.type === 'recon/start')).toHaveLength(1);
    expect(graph.counts().evidence).toBe(1);
  } finally { graph.close(); await fixture.trajectories.flush(); await fixture.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
