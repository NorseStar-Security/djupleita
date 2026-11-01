import { it, expect } from 'vitest';
import { ScopeService } from '../packages/scope/src/index.ts';
import { CrawlFrontier, CrawlService, linksFromHtml } from '../packages/crawl/src/index.ts';
import { AttackGraph } from '../packages/graph/src/index.ts';
import { AuthzService } from '../packages/authz/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
import { scope } from './fixtures.ts';
import { lab } from './http-lab.ts';

it('deduplicates discoveries per identity, bounds endpoint templates, and keeps scope fixed', () => {
  const frontier = new CrawlFrontier({ maxPages: 10, maxDepth: 2, maxQueued: 20, maxPerTemplate: 1, stalePageLimit: 3 },
    new ScopeService(scope('app.test')));
  const alice = id<'IdentityId'>(), bob = id<'IdentityId'>();
  for (const identityId of [alice, bob]) {
    expect(frontier.offer({ url: 'https://app.test/api/1#fragment', source: 'browser', identityId, depth: 0 })).toBe(true);
    expect(frontier.offer({ url: 'https://app.test/api/1', source: 'rea', identityId, depth: 0 })).toBe(false);
  }
  expect(frontier.offer({ url: 'https://app.test/api/2', source: 'recon', identityId: alice, depth: 0 })).toBe(true);
  expect(frontier.offer({ url: 'https://outside.test/', source: 'http', depth: 0 })).toBe(false);
  expect(frontier.offer({ url: 'https://app.test/deleteUser', source: 'http', depth: 0 })).toBe(false);
  expect(frontier.next()).toBeDefined(); expect(frontier.next()).toBeDefined(); expect(frontier.next()).toBeUndefined();
  expect(frontier.rejected.map(item => item.reason).join(' ')).toMatch(/Deletion.*template/);
  expect(linksFromHtml('<a href="/x">x</a><form action="/submit"><a href="javascript:alert(1)">bad</a>', 'https://app.test/start'))
    .toEqual(['https://app.test/x', 'https://app.test/submit']);
});

it('records a crawl and A/B/anonymous IDOR candidate in the same evidence graph', async () => {
  const fixture = await lab();
  const graph = new AttackGraph(':memory:', id<'EngagementId'>());
  try {
    const config = scope('localhost', Number(new URL(fixture.url).port)); config.targets[0]!.schemes = ['http']; config.networks = ['127.0.0.1/32'];
    const frontier = new CrawlFrontier({ maxPages: 1, maxDepth: 2, maxQueued: 10, maxPerTemplate: 3, stalePageLimit: 3 }, new ScopeService(config));
    const crawler = new CrawlService(frontier, fixture.broker, graph);
    crawler.observe([`${fixture.url}/objects/1`], 'seed');
    expect((await crawler.run(fixture.sessionId, AbortSignal.timeout(5000))).visited).toBe(1);
    const alice = await fixture.identities.create({ name: 'Alice', role: 'member', tenant: 'a', hosts: ['localhost'], kind: 'bearer' }, 'alice-token');
    const bob = await fixture.identities.create({ name: 'Bob', role: 'member', tenant: 'b', hosts: ['localhost'], kind: 'bearer' }, 'bob-token');
    const authz = new AuthzService(fixture.broker, fixture.identities, graph, fixture.trajectories);
    const input = { request: { url: `${fixture.url}/objects/1`, method: 'GET' as const, headers: {} }, identityA: alice.id, identityB: bob.id, anonymous: true };
    const candidate = await authz.compare(input, fixture.sessionId, AbortSignal.timeout(5000));
    expect(candidate.verdict).toBe('candidate'); expect(candidate.replays).toHaveLength(3);
    expect(graph.snapshot().edges.filter(edge => edge.type === 'CanRead').every(edge => edge.status === 'inferred')).toBe(true);
    authz.registerAssertion({ id: 'fixture-alice-ownership', description: 'The lab fixture assigns object 1 to Alice and forbids Bob/anonymous',
      verify(request, results) { return request.identityA === alice.id && [...results.values()].every(result =>
        result.status === 200 && JSON.parse(result.body).owner === 'alice'); } });
    const verified = await authz.compare(input, fixture.sessionId, AbortSignal.timeout(5000), 'fixture-alice-ownership');
    expect(verified.verdict).toBe('verified');
    expect(graph.snapshot().edges.some(edge => edge.status === 'verified')).toBe(true);
    expect(JSON.stringify(graph.snapshot())).not.toMatch(/alice-token|bob-token/);
  } finally { graph.close(); await fixture.close(); }
});
