import { it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FuzzGateway, FuzzInputSchema, FuzzConfigSchema, FuzzService } from '../packages/fuzz/src/index.ts';
import { AttackGraph } from '../packages/graph/src/index.ts';
import { CrawlFrontier, CrawlService } from '../packages/crawl/src/index.ts';
import { lab } from './http-lab.ts';

it('requires a fixed HTTP origin and a URL placeholder, and rejects arbitrary CLI flags', () => {
  for (const url of ['https://FUZZ.example.test/FUZZ', 'https://user:pass@example.test/FUZZ', 'file:///tmp/FUZZ', 'https://example.test/', 'https://example.test/FUZZ#fragment']) {
    expect(FuzzInputSchema.safeParse({ url }).success, url).toBe(false);
  }
  expect(FuzzInputSchema.safeParse({ url: 'https://example.test/?q=FUZZ' }).success).toBe(true);
  expect(FuzzInputSchema.safeParse({ url: 'https://example.test/FUZZ', args: ['-input-cmd', 'shell'] }).success).toBe(false);
  expect(FuzzInputSchema.safeParse({ url: 'https://example.test/FUZZ', words: ['one\ntwo'] }).success).toBe(false);
});

it('brokers each generated URL, redacts identity secrets and blocks deletion semantics before dispatch', async () => {
  const f = await lab();
  const alice = await f.identities.create({ name: 'Alice', role: 'member', tenant: 'a', hosts: ['localhost'], kind: 'bearer' }, 'ffuf-fixture-token');
  const input = FuzzInputSchema.parse({ url: `${f.url}/FUZZ`, identityId: alice.id });
  const gateway = new FuzzGateway(input, 2, f.broker, f.sessionId, AbortSignal.timeout(5000), f.redactor);
  await gateway.start();
  try {
    const response = await fetch(gateway.template.replace('FUZZ', 'objects/1'));
    expect(response.status).toBe(200); expect(await response.text()).not.toContain('ffuf-fixture-token');
    expect(f.observed).toEqual([{ path: '/objects/1', authorization: 'Bearer ffuf-fixture-token' }]);
    await expect(fetch(gateway.template.replace('FUZZ', 'delete'))).rejects.toThrow();
    expect(f.observed).toHaveLength(1); expect(gateway.errorCount).toBe(1);
    expect(gateway.errors[0]?.message).toContain('one-shot');
    expect(JSON.stringify([...gateway.responses.values()])).not.toContain('ffuf-fixture-token');
    expect([...gateway.responses.values()][0]?.body).toBe('');
  } finally { await gateway.close(); await f.close(); }
});

it('does not follow redirects, enforce another origin, or exceed the per-run request count', async () => {
  const f = await lab(), input = FuzzInputSchema.parse({ url: `${f.url}/FUZZ` });
  const gateway = new FuzzGateway(input, 1, f.broker, f.sessionId, AbortSignal.timeout(5000), f.redactor);
  await gateway.start();
  try {
    const response = await fetch(gateway.template.replace('FUZZ', 'redirect'));
    expect(response.status).toBe(302); expect(response.headers.get('location')).toBeNull();
    expect(f.observed).toHaveLength(1);
    const doubleSlash = gateway.target(gateway.template.replace('FUZZ', '/outside.invalid/private'));
    expect(new URL(doubleSlash).origin).toBe(f.url);
    expect(() => gateway.target('http://outside.invalid/FUZZ')).toThrow('route');
    await expect(fetch(gateway.template.replace('FUZZ', 'objects/2'))).rejects.toThrow();
    expect(f.observed).toHaveLength(1); expect(gateway.errors[0]?.message).toContain('bounded wordlist');
  } finally { await gateway.close(); await f.close(); }
});

it('cancels pending broker calls when the worker gateway closes', async () => {
  const f = await lab(), gateway = new FuzzGateway(FuzzInputSchema.parse({ url: `${f.url}/FUZZ` }), 1,
    f.broker, f.sessionId, AbortSignal.timeout(5000), f.redactor);
  let started = false;
  vi.spyOn(f.broker, 'deliver').mockImplementation(async (_input, _session, signal) => {
    started = true;
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    throw new Error('unreachable');
  });
  await gateway.start();
  const pending = fetch(gateway.template.replace('FUZZ', 'objects')).catch(() => undefined);
  try { await expect.poll(() => started).toBe(true); await gateway.close(); await pending; expect(gateway.errors[0]?.message).toBe('cancelled'); }
  finally { await f.close(); }
});

it.skipIf(!process.env.DSH_TEST_FFUF || process.platform !== 'darwin')('runs real ffuf through the macOS worker and records only matching broker observations', async () => {
  const f = await lab(), binary = process.env.DSH_TEST_FFUF!;
  const graph = new AttackGraph(join(f.root, 'graph.sqlite'), f.config.id);
  const crawl = new CrawlService(new CrawlFrontier({ maxPages: 100, maxDepth: 4, maxQueued: 100, maxPerTemplate: 3, stalePageLimit: 5 }, f.scopes), f.broker, graph);
  const config = FuzzConfigSchema.parse({ binary: { path: binary, sha256: createHash('sha256').update(await readFile(binary)).digest('hex') }, timeoutMs: 10000 });
  const service = new FuzzService(config, join(f.root, 'fuzz'), f.sessions, () => f.broker, () => crawl, f.evidence, f.trajectories, f.redactor);
  try {
    const result = await service.run(FuzzInputSchema.parse({ url: `${f.url}/FUZZ`, words: ['objects/1', 'redirect'], matchStatus: [200], rate: 100, concurrency: 1 }), f.sessionId, AbortSignal.timeout(15000)) as Record<string, unknown>;
    expect(result, JSON.stringify(result)).toMatchObject({ completed: true, matched: 1, responses: 2, exitCode: 0, errorCount: 0 });
    expect(f.observed.map(row => row.path).sort()).toEqual(['/objects/1', '/redirect']);
    expect(graph.snapshot().nodes.some(row => row.type === 'Endpoint')).toBe(true);
    expect(graph.snapshot().nodes.some(row => row.name.includes('redirect'))).toBe(false);
    expect(crawl.frontier.snapshot().queued.some(row => row.url === `${f.url}/objects/1` && row.source === 'fuzz')).toBe(true);
    const events = await f.trajectories.read(f.sessionId);
    expect(events.map(row => row.type)).toContain('fuzz/result');
    expect(JSON.stringify(result)).not.toContain('127.0.0.1:');
    config.binary!.sha256 = '0'.repeat(64);
    await expect(service.run(FuzzInputSchema.parse({ url: `${f.url}/FUZZ`, words: ['admin'] }), f.sessionId, AbortSignal.timeout(3000))).rejects.toThrow('SHA-256');
  } finally { graph.close(); await f.close(); }
}, 20000);
