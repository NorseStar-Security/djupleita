import { it, expect } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserService } from '../packages/browser/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { IdentityService } from '../packages/identities/src/index.ts';
import { Redactor, TrajectoryStore, EvidenceStore } from '../packages/trajectory/src/index.ts';
import { HttpBroker } from '../packages/http/src/index.ts';
import { PolicyService } from '../packages/policy/src/index.ts';
import { AttackGraph } from '../packages/graph/src/index.ts';
import { CrawlFrontier, CrawlService } from '../packages/crawl/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, policyConfig, testJudge, scope } from './fixtures.ts';

it.skipIf(process.platform !== 'darwin')('brokers a real browser, isolates A/B credentials and rejects cross-scope requests', async () => {
  const observed: string[] = [];
  const server = http.createServer((req, res) => {
    observed.push(`${req.url}:${req.headers.authorization ?? 'anonymous'}`);
    res.setHeader('content-type', 'text/html');
    res.end('<title>Identity lab</title><h1>Authorized fixture</h1><a href="/object/1">Object</a><img src="http://outside.invalid/leak"><script>fetch("/api/me")</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No lab port');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-browser-')));
  const config = engagement({ scope: scope('localhost', address.port) });
  config.scope.targets[0]!.schemes = ['http']; config.scope.networks = ['127.0.0.1/32'];
  const scopes = new ScopeService(config.scope, async () => [{ address: '127.0.0.1', family: 4 }]);
  const redactor = new Redactor(), trajectories = new TrajectoryStore(join(root, 'trajectory'), config.id, redactor), evidence = new EvidenceStore(root, redactor);
  const secretValues = new Map<string, string>();
  const identities = new IdentityService(config.id, { async get(key) { return secretValues.get(key); }, async set(key, value) { secretValues.set(key, value); }, async remove(key) { secretValues.delete(key); } }, redactor);
  const a = await identities.create({ name: 'Alice', role: 'user', tenant: 'A', kind: 'bearer', hosts: ['localhost'] }, 'alice-lab-secret');
  const b = await identities.create({ name: 'Bob', role: 'user', tenant: 'B', kind: 'bearer', hosts: ['localhost'] }, 'bob-lab-secret');
  const sessions = new EngagementService(config), session = id<'SessionId'>(); sessions.attach(session);
  const policy = new PolicyService(policyConfig, scopes, testJudge, config.model, trajectories, redactor);
  const broker = new HttpBroker({ timeoutMs: 10000, maxRedirects: 3, maxRequestBytes: 4096 }, sessions, scopes, policy, identities, trajectories, evidence, redactor);
  const graph = new AttackGraph(join(root, 'graph.sqlite'), config.id);
  const crawl = new CrawlService(new CrawlFrontier({ maxPages: 10, maxDepth: 2, maxQueued: 100, maxPerTemplate: 3, stalePageLimit: 5 }, scopes), broker, graph);
  const browser = new BrowserService({ root: join(root, 'browser') }, scopes, () => broker, identities, trajectories, evidence, redactor, () => crawl, new AbortController().signal);
  try {
    const url = `http://localhost:${address.port}/`;
    const first = await browser.execute({ operation: 'navigate', url }, session, a.id, AbortSignal.timeout(20000));
    const second = await browser.execute({ operation: 'navigate', url }, session, b.id, AbortSignal.timeout(20000));
    expect(JSON.stringify(first)).toContain('Authorized fixture'); expect(JSON.stringify(second)).toContain('Identity lab');
    expect(observed).toContain('/:Bearer alice-lab-secret'); expect(observed).toContain('/:Bearer bob-lab-secret');
    const events = await trajectories.read(session);
    expect(events.some(event => event.type === 'browser/blocked')).toBe(true);
    expect(JSON.stringify(events)).not.toContain('alice-lab-secret'); expect(JSON.stringify(events)).not.toContain('bob-lab-secret');
    expect(crawl.frontier.snapshot().queued.some(candidate => candidate.url.endsWith('/object/1'))).toBe(true);
    await expect(browser.execute({ operation: 'navigate', url: 'http://outside.invalid/' }, session, a.id, AbortSignal.timeout(1000))).rejects.toThrow();
  } finally { await browser.close(); graph.close(); server.closeAllConnections(); server.close(); await once(server, 'close'); }
}, 60000);
