import { describe, it, expect, vi } from 'vitest';
import { ScopeService, matchesHost } from '../packages/scope/src/index.ts';
import { scope } from './fixtures.ts';

describe('engagement destinations', () => {
  it('matches wildcard subdomains without granting the apex or suffix lookalikes', () => {
    expect(matchesHost('api.dropbox.com', '*.dropbox.com')).toBe(true);
    expect(matchesHost('a.b.dropbox.com', '*.dropbox.com')).toBe(true);
    expect(matchesHost('dropbox.com', '*.dropbox.com')).toBe(false);
    expect(matchesHost('dropbox.com.evil.test', '*.dropbox.com')).toBe(false);
    expect(matchesHost('evildropbox.com', '*.dropbox.com')).toBe(false);
    expect(matchesHost('API.DROPBOX.COM.', '*.dropbox.com')).toBe(true);
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
