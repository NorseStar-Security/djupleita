import { describe, it, expect, vi } from 'vitest';
import { ScopeService, matchesHost } from '../packages/scope/src/index.ts';
import { scope } from './fixtures.ts';
import courseScope from '../configs/scope.example.json' with { type: 'json' };
import template from '../configs/engagement.example.json' with { type: 'json' };
import { ScopeSchema } from '../packages/contracts/src/index.ts';

describe('engagement destinations', () => {
  it('loads course defaults with enforcement off and enforces the production exception when enabled', async () => {
    expect(template.scope).toEqual(courseScope);
    expect(courseScope.enabled).toBe(false);
    // Exercise the shipped rule shape using only reserved fixture hosts and local DNS answers.
    const suffix = courseScope.targets[0]!.host.split('.').slice(-2).join('.');
    const fixture = ScopeSchema.parse(JSON.parse(JSON.stringify(courseScope).replaceAll(suffix, 'example.test')));
    const resolver = async () => [{ address: '10.20.30.40', family: 4 }];
    const off = new ScopeService(fixture, resolver);
    await expect(off.authorize({ url: 'http://outside.example.test:8123/', purpose: 'target' })).resolves.toBeTruthy();
    const on = new ScopeService({ ...fixture, enabled: true }, resolver);
    for (const host of ['www.prod.example.test', 'app.dev.example.test', 'app.test.example.test', 'nested.app.dev.example.test']) {
      await expect(on.authorize({ url: `https://${host}/any/path`, purpose: 'target' })).resolves.toMatchObject({ addresses: [{ address: '10.20.30.40', family: 4 }] });
    }
    for (const host of ['mail.prod.example.test', 'nested.www.prod.example.test', 'prod.example.test', 'dev.example.test', 'test.example.test', 'example.test', 'outside.example.test', 'www.prod.example.test.evil.example.test']) {
      expect(() => on.check({ url: `https://${host}/`, purpose: 'target' })).toThrow('outside');
    }
    expect(() => on.check({ url: 'https://www.prod.example.test:8443/', purpose: 'target' })).toThrow('outside');
  });
  it('disables only target boundaries while retaining URL validation, DNS pinning, services and legacy enforcement', async () => {
    const resolver = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
    const config = { ...scope(), enabled: false, exclusions: ['excluded.example.test'] };
    const service = new ScopeService(config, resolver);
    for (const host of ['excluded.example.test', '127.0.0.1', '[::1]']) {
      const grant = await service.authorize({ url: `http://${host}:8123/private`, purpose: 'target' });
      expect(grant.addresses).toHaveLength(1); expect(Object.isFrozen(grant.addresses)).toBe(true);
    }
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(() => service.check({ url: 'https://excluded.example.test/', purpose: 'target', access: 'read' })).not.toThrow();
    for (const purpose of ['model', 'intelligence', 'telemetry'] as const) {
      expect(() => service.check({ url: 'https://outside.example.test/', purpose })).toThrow('outside');
    }
    expect(() => service.check({ url: 'file:///tmp/fixture', purpose: 'target' })).toThrow();
    expect(() => service.check({ url: 'https://u:p@app.example.test/', purpose: 'target' })).toThrow('Credentials');
    expect(() => new ScopeService(scope()).check({ url: 'https://outside.test/', purpose: 'target' })).toThrow('outside');
    const malformed = new ScopeService(config, async () => [{ address: '127.0.0.1', family: 6 }]);
    await expect(malformed.authorize({ url: 'http://outside.example.test/', purpose: 'target' })).rejects.toThrow('family');
  });
  it('matches wildcard subdomains without granting the apex or suffix lookalikes', () => {
    expect(matchesHost('api.example.test', '*.example.test')).toBe(true);
    expect(matchesHost('a.b.example.test', '*.example.test')).toBe(true);
    expect(matchesHost('example.test', '*.example.test')).toBe(false);
    expect(matchesHost('example.test.evil.test', '*.example.test')).toBe(false);
    expect(matchesHost('evilexample.test', '*.example.test')).toBe(false);
    expect(matchesHost('API.EXAMPLE.TEST.', '*.example.test')).toBe(true);
  });
  it('rejects malformed wildcard and network configuration at startup', () => {
    expect(() => new ScopeService(scope('api.*.example.test'))).toThrow(/Wildcard|Invalid/);
    expect(() => new ScopeService({ ...scope(), networks: ['garbage'] })).toThrow(/network/);
  });
  it('keeps service destinations separate from targets and applies exclusions first', () => {
    const config = scope();
    config.services.model = [{ ...config.targets[0]!, host: 'models.provider.test' }];
    config.exclusions = ['admin.example.test'];
    const service = new ScopeService(config);
    expect(() => service.check({ url: 'https://admin.example.test/', purpose: 'target' })).toThrow(/Excluded/);
    expect(() => service.check({ url: 'https://models.provider.test/', purpose: 'target' })).toThrow(/outside/);
    expect(service.check({ url: 'https://models.provider.test/', purpose: 'model' }).url.hostname).toBe('models.provider.test');
    expect(() => service.check({ url: 'https://u:p@app.example.test/', purpose: 'target' })).toThrow(/Credentials/);
    expect(() => service.check({ url: 'https://app.example.test:8443/', purpose: 'target' })).toThrow(/outside/);
  });
  it('checks every DNS answer and rechecks DNS on each authorization', async () => {
    const resolver = vi.fn().mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const service = new ScopeService(scope(), resolver);
    const grant = await service.authorize({ url: 'https://app.example.test/', purpose: 'target' });
    expect(grant.addresses[0]?.address).toBe('93.184.216.34');
    await expect(service.authorize({ url: 'https://app.example.test/', purpose: 'target' })).rejects.toThrow(/unapproved/);
    const mixed = new ScopeService(scope(), async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }]);
    await expect(mixed.authorize({ url: 'https://app.example.test/', purpose: 'target' })).rejects.toThrow(/unapproved/);
  });
  it('requires explicit direct IP authorization and makes scope revisions immutable', async () => {
    const config = scope('127.0.0.1', 443);
    const denied = new ScopeService(config);
    expect(() => denied.check({ url: 'https://127.0.0.1/', purpose: 'target' })).toThrow(/network/);
    config.networks = ['127.0.0.1/32'];
    const service = new ScopeService(config);
    expect((await service.authorize({ url: 'https://127.0.0.1/', purpose: 'target' })).addresses).toHaveLength(1);
    config.targets[0]!.host = '*.evil.test';
    expect(service.check({ url: 'https://127.0.0.1/', purpose: 'target' }).rule.host).toBe('127.0.0.1');
    expect(() => service.scope.targets.push(config.targets[0]!)).toThrow();
  });
  it('restricts paths on segment boundaries', () => {
    const config = scope(); config.targets[0]!.pathPrefixes = ['/api'];
    const service = new ScopeService(config);
    expect(service.check({ url: 'https://app.example.test/api/items', purpose: 'target' })).toBeTruthy();
    expect(() => service.check({ url: 'https://app.example.test/apiculture', purpose: 'target' })).toThrow(/outside/);
    expect(() => service.check({ url: 'https://app.example.test/api/%2e%2e/admin', purpose: 'target' })).toThrow(/outside/);
  });
});
