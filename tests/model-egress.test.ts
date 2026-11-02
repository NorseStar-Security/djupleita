import { it, expect, vi } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { ModelFetchBroker } from '../packages/http/src/model-fetch.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { Redactor } from '../packages/trajectory/src/index.ts';
import { scope } from './fixtures.ts';

it('trusts only the configured model API root without widening target scope', () => {
  const scopes = new ScopeService(scope('target.invalid'));
  const provider = scopes.forModelEndpoints(['https://api.openai.com/v1']);
  expect(provider.check({ url: 'https://api.openai.com/v1/responses', purpose: 'model' }).url.hostname).toBe('api.openai.com');
  for (const url of ['https://api.openai.com/other', 'https://api.openai.com/v10/responses',
    'http://api.openai.com/v1/responses', 'https://api.openai.com:444/v1/responses', 'https://other.invalid/v1/responses']) {
    expect(() => provider.check({ url, purpose: 'model' })).toThrow();
  }
  expect(() => provider.check({ url: 'https://api.openai.com/v1/responses', purpose: 'target' })).toThrow();
  expect(() => scopes.check({ url: 'https://api.openai.com/v1/responses', purpose: 'model' })).toThrow();
  expect(() => scopes.forModelEndpoints(['file:///tmp/key'])).toThrow('HTTP(S)');
  expect(() => scopes.forModelEndpoints(['https://key@api.openai.com/v1'])).toThrow('credentials');
});

it('does not prompt again for configured providers after engagement scope changes', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('ok'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture');
  const request = vi.fn(async () => false), allows = () => false;
  const broker = new ModelFetchBroker(new Redactor()), dispose = broker.install();
  try {
    for (const host of ['first.invalid', 'second.invalid', 'third.invalid']) {
      const scopes = new ScopeService(scope(host), async () => [{ address: '127.0.0.1', family: 4 }], { request, allows });
      const provider = scopes.forModelEndpoints([`http://localhost:${address.port}/v1/`]);
      const response = await broker.run(scopes, AbortSignal.timeout(2000),
        () => fetch(`http://localhost:${address.port}/v1/responses`), provider);
      expect(await response.text()).toBe('ok');
    }
    expect(hits).toBe(3); expect(request).not.toHaveBeenCalled();
  } finally { dispose(); server.closeAllConnections(); server.close(); await once(server, 'close'); }
});

it('retains network review for public provider DNS answers that resolve privately', async () => {
  const request = vi.fn(async () => false);
  const scopes = new ScopeService(scope(), async () => [{ address: '127.0.0.1', family: 4 }], { request, allows: () => false });
  const provider = scopes.forModelEndpoints(['https://api.openai.com/v1']);
  await expect(provider.authorize({ url: 'https://api.openai.com/v1/responses', purpose: 'model' })).rejects.toThrow('loopback');
  expect(request).toHaveBeenCalledWith('network', expect.anything(), expect.any(String), expect.any(AbortSignal));
});

it('accepts configured named private gateways and explicit auxiliary roots without trusting loopback DNS rebinding', async () => {
  const request = vi.fn(async () => false);
  for (const address of [{ address: '10.20.30.40', family: 4 }, { address: 'fd00::40', family: 6 }]) {
    const scopes = new ScopeService(scope('target.example.test'), async () => [address], { request, allows: () => false });
    const provider = scopes.forModelEndpoints(['https://gateway.example.test/v1', 'https://uploads.example.test/files']);
    for (const url of ['https://gateway.example.test/v1/responses', 'https://uploads.example.test/files/input']) {
      expect((await provider.authorize({ url, purpose: 'model' })).addresses).toEqual([address]);
      expect(() => scopes.check({ url, purpose: 'target' })).toThrow();
    }
    await expect(provider.authorize({ url: 'https://undeclared.example.test/v1', purpose: 'model' })).rejects.toThrow('outside');
  }
  expect(request).toHaveBeenCalledTimes(2);
});

it('reviews unexpected endpoints and refuses redirects even for configured providers', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.writeHead(302, { location: '/v1/final' }); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture');
  const request = vi.fn(async () => false);
  const scopes = new ScopeService({ ...scope(), targets: [], services: { model: [], intelligence: [], telemetry: [] } },
    undefined, { request, allows: () => false });
  const endpoint = `http://127.0.0.1:${address.port}/v1`;
  const broker = new ModelFetchBroker(new Redactor()), dispose = broker.install();
  const provider = scopes.forModelEndpoints([endpoint]);
  const run = (url: string) => broker.run(scopes, AbortSignal.timeout(2000), () => fetch(url), provider);
  try {
    await expect(run(`http://127.0.0.1:${address.port}/unexpected`)).rejects.toThrow('outside model scope');
    expect(request).toHaveBeenCalledWith('scope', expect.anything(), expect.any(String), expect.any(AbortSignal));
    expect(hits).toBe(0); request.mockClear();
    await expect(run(`${endpoint}/responses`)).rejects.toThrow('redirect');
    expect(hits).toBe(1); expect(request).not.toHaveBeenCalled();
  } finally { dispose(); server.closeAllConnections(); server.close(); await once(server, 'close'); }
});

it('pins provider fetches to model scope and refuses redirects without leaking credentials', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => { hits++; if (req.url === '/redirect') { res.writeHead(302, { location: 'http://outside.invalid/' }); res.end(); }
    else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); res.end('data: second\n\n'); } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture');
  const config = scope('target.invalid'); config.networks = ['127.0.0.1/32'];
  config.services.model = [{ host: 'localhost', ports: [address.port], schemes: ['http'], pathPrefixes: ['/'], allowPrivateAddresses: true }];
  const scopes = new ScopeService(config, async () => [{ address: '127.0.0.1', family: 4 }]);
  const redactor = new Redactor(), broker = new ModelFetchBroker(redactor), dispose = broker.install();
  const run = <T>(operation: () => T) => broker.run(scopes, AbortSignal.timeout(3000), operation);
  try {
    await expect(run(() => fetch(`http://127.0.0.1:${address.port}/`))).rejects.toThrow(); expect(hits).toBe(0);
    const response = await run(() => fetch(`http://localhost:${address.port}/`, { headers: { authorization: 'Bearer model-secret' } }));
    expect(await response.text()).toBe('data: first\n\ndata: second\n\n');
    expect(redactor.text('model-secret')).toBe('[REDACTED]');
    await expect(run(() => fetch(`http://localhost:${address.port}/redirect`))).rejects.toThrow('redirect'); expect(hits).toBe(2);
  } finally { dispose(); server.closeAllConnections(); server.close(); await once(server, 'close'); }
});
