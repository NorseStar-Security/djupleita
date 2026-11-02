import { expect, it, vi } from 'vitest';
import { ScopeService } from '../packages/scope/src/index.ts';
import { PolicyService } from '../packages/policy/src/index.ts';
import { HttpBroker, httpDestination } from '../packages/http/src/index.ts';
import type { HttpInput, Transport } from '../packages/http/src/index.ts';
import { Redactor } from '../packages/trajectory/src/index.ts';
import { ReconService } from '../packages/recon/src/index.ts';
import type { Action } from '../packages/contracts/src/index.ts';
import { action, scope, policyConfig, testJudge, MemorySink } from './fixtures.ts';
import { lab } from './http-lab.ts';

const read = { url: 'https://research.example.test/blog/CVE-2026-0001', purpose: 'target', access: 'read' } as const;

it('allows unlisted web research while preserving active target, service and exclusion boundaries', async () => {
  const config = scope('target.example.test');
  config.exclusions = ['blocked.example.test', '*.excluded.example.test'];
  const resolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
  const service = new ScopeService(config, resolver);
  await expect(service.authorize(read)).resolves.toMatchObject({ url: new URL(read.url), addresses: [{ address: '93.184.216.34', family: 4 }] });
  for (const access of [undefined, 'active'] as const) {
    expect(() => service.check({ url: read.url, purpose: 'target', ...(access ? { access } : {}) })).toThrow('outside');
  }
  for (const purpose of ['intelligence', 'model', 'telemetry'] as const) {
    expect(() => service.check({ ...read, purpose })).toThrow('outside');
  }
  for (const host of ['blocked.example.test', 'a.excluded.example.test']) {
    await expect(service.authorize({ ...read, url: `https://${host}/` })).rejects.toThrow('Excluded');
    expect(() => service.check({ url: `https://${host}/`, purpose: 'target' })).toThrow('Excluded');
  }
  expect(() => service.check({ ...read, url: 'tcp://research.example.test:443/' })).toThrow('outside');
  expect(resolver).toHaveBeenCalledTimes(1);
});

it('disables target exclusions and network boundaries for reads and active calls without asking for scope review', async () => {
  const config = { ...scope('target.example.test'), enabled: false, exclusions: ['excluded.example.test'] };
  const reviewer = { allows: vi.fn(() => false), request: vi.fn(async () => false) };
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  const off = new ScopeService(config, resolver, reviewer);
  for (const access of ['read', 'active'] as const) {
    await expect(off.authorize({ url: 'http://excluded.example.test:8123/private', purpose: 'target', access })).resolves.toBeTruthy();
  }
  expect(reviewer.allows).not.toHaveBeenCalled(); expect(reviewer.request).not.toHaveBeenCalled();
  expect(off.instructions()).toContain('Saved target rules and exclusions are inactive');
  expect(off.instructions()).not.toContain('Exclusions block reads');
  const on = new ScopeService({ ...config, enabled: true }, resolver, reviewer);
  for (const access of ['read', 'active'] as const) {
    expect(() => on.check({ url: 'http://excluded.example.test:8123/private', purpose: 'target', access })).toThrow('Excluded');
  }
});

it('retains DNS pinning, rebinding checks and explicit private-network grants for unlisted reads', async () => {
  const resolver = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
    .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
  const service = new ScopeService(scope(), resolver);
  const grant = await service.authorize(read);
  expect(Object.isFrozen(grant.addresses[0])).toBe(true);
  await expect(service.authorize(read)).rejects.toThrow('unapproved');
  for (const address of ['10.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const privateScope = new ScopeService(scope(), async () => [{ address, family: address.includes(':') ? 6 : 4 }]);
    await expect(privateScope.authorize(read)).rejects.toThrow('unapproved');
  }
  await expect(service.authorize({ ...read, url: 'http://127.0.0.1/' })).rejects.toThrow('unapproved');
  const granted = new ScopeService({ ...scope(), networks: ['127.0.0.1/32'] }, async () => [{ address: '127.0.0.1', family: 4 }]);
  await expect(granted.authorize(read)).resolves.toBeTruthy();
});

it('derives research access from HTTP semantics and keeps destructive or body-bearing requests active', () => {
  const input: HttpInput = { url: read.url, method: 'GET', headers: {} };
  for (const method of ['GET', 'HEAD', 'OPTIONS'] as const) expect(httpDestination({ ...input, method }).access).toBe('read');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) expect(httpDestination({ ...input, method }).access).toBe('active');
  expect(httpDestination({ ...input, body: 'mutation' }).access).toBe('active');
  for (const path of ['/items?action=delete', '/logout', '/revoke-token']) {
    expect(httpDestination({ ...input, url: `https://research.example.test${path}` }).access).toBe('active');
  }
  expect(httpDestination(input, 'active').access).toBe('active');
});

it('rejects a read label on mutations and unknown adapters before model or action approval', async () => {
  const judge = vi.fn(testJudge.judge), approve = vi.fn(async () => true);
  const policy = new PolicyService(policyConfig, new ScopeService(scope('target.example.test')), { name: 'fixture', judge },
    { provider: 'fixture', model: 'fixture' }, new MemorySink(), new Redactor());
  const request = { action: action({ destinations: [read] }), signal: AbortSignal.timeout(5000) };
  await expect(policy.authorize(request, approve)).resolves.toMatchObject({ kind: 'allow' });
  expect(judge).toHaveBeenCalledOnce(); judge.mockClear();
  const overrides: Partial<Action>[] = [{ effects: ['modify'] }, { effects: ['delete'], reversible: false },
    { effects: ['unknown'] }, { plugin: 'unadapted' }, { reversible: false }];
  for (const override of overrides) {
    const operation = action({ destinations: [read], ...override });
    await expect(policy.authorize({ ...request, action: operation }, approve)).rejects.toThrow('outside');
  }
  expect(judge).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
});

it('rechecks every redirect and blocks external writes, destructive GETs and active reads before transport', async () => {
  const fixture = await lab();
  try {
    const config = { ...fixture.config.scope, targets: [], exclusions: ['excluded.example.test'] };
    const scopes = new ScopeService(config, async () => [{ address: '127.0.0.1', family: 4 }]);
    const policy = new PolicyService(policyConfig, scopes, testJudge, fixture.config.model, fixture.trajectories, fixture.redactor);
    const calls: HttpInput[] = [];
    const transport: Transport = async (_grant, input) => {
      calls.push(input);
      const path = new URL(input.url).pathname;
      if (path === '/redirect') return { status: 302, headers: { location: 'https://second.example.test/blog' }, body: '' };
      if (path === '/excluded') return { status: 302, headers: { location: 'https://excluded.example.test/blog' }, body: '' };
      if (path === '/destructive') return { status: 302, headers: { location: '/items?action=delete' }, body: '' };
      return { status: 200, headers: {}, body: 'Research fixture' };
    };
    const broker = new HttpBroker({ timeoutMs: 5000, maxRedirects: 3, maxRequestBytes: 4096 }, fixture.sessions, scopes,
      policy, fixture.identities, fixture.trajectories, fixture.evidence, fixture.redactor, transport);
    const request = (path: string, method: HttpInput['method'] = 'GET') => broker.request({ url: `https://research.example.test${path}`, method, headers: {} },
      fixture.sessionId, AbortSignal.timeout(5000));
    await expect(request('/redirect')).resolves.toMatchObject({ url: 'https://second.example.test/blog', body: 'Research fixture' });
    await expect(request('/excluded')).rejects.toThrow('Excluded');
    await expect(request('/destructive')).rejects.toThrow('outside');
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) await expect(request('/blog', method)).rejects.toThrow('outside');
    await expect(broker.request({ url: read.url, method: 'GET', headers: {} }, fixture.sessionId, AbortSignal.timeout(5000), undefined, 'active')).rejects.toThrow('outside');
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(['/redirect', '/blog', '/excluded', '/destructive']);
  } finally { await fixture.close(); }
});

it('allows passive subject research without authorizing active recon', () => {
  const scopes = new ScopeService({ ...scope('target.example.test'), exclusions: ['excluded.example.test'] });
  const recon = new ReconService({ binaries: {}, sources: ['crtsh'], timeoutMs: 1000 }, '/unused', scopes,
    undefined as never, undefined as never, undefined as never, undefined as never, undefined as never, undefined as never);
  expect(() => recon.check({ tool: 'subfinder', target: 'research.example.test', depth: 1 })).not.toThrow();
  expect(() => recon.check({ tool: 'subfinder', target: 'excluded.example.test', depth: 1 })).toThrow('Excluded');
  for (const tool of ['httpx', 'katana'] as const) expect(() => recon.check({ tool, target: read.url, depth: 1 })).toThrow('outside');
});
