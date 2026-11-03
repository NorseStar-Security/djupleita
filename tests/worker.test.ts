import { it, expect } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, WorkerProxy } from '../packages/worker/src/index.ts';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, scope } from './fixtures.ts';

it.each([{ enabled: false, purpose: 'target', allowed: true }, { enabled: true, purpose: 'target', allowed: false },
  { enabled: false, purpose: 'model', allowed: false }] as const)('checks target scope management $enabled for $purpose proxy tunnels', async ({ enabled, purpose, allowed }) => {
  let hits = 0;
  const target = net.createServer(client => { hits++; client.end('local tunnel fixture'); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const address = target.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const root = await mkdtemp(join(tmpdir(), 'djupleita-proxy-toggle-'));
  const config = engagement({ scope: { ...scope('allowed.example.test'), enabled } });
  const redactor = new Redactor(), trajectory = new TrajectoryStore(join(root, 'events'), config.id, redactor);
  const session = id<'SessionId'>(), sessions = new EngagementService(config); sessions.attach(session);
  const proxy = new WorkerProxy(new ScopeService(config.scope), sessions, trajectory, redactor, session, purpose, AbortSignal.timeout(5000));
  try {
    await proxy.start();
    const endpoint = new URL(proxy.endpoint);
    const output = await new Promise<string>((resolve, reject) => {
      const client = net.connect({ host: endpoint.hostname, port: Number(endpoint.port) }); let text = '';
      client.on('error', reject); client.on('data', data => { text += data; }); client.on('end', () => resolve(text));
      client.on('connect', () => client.write(`CONNECT 127.0.0.1:${address.port} HTTP/1.1\r\nHost: 127.0.0.1:${address.port}\r\nProxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}\r\n\r\n`));
    });
    expect(output).toContain(allowed ? '200 Connection Established' : '403 Forbidden');
    expect(hits).toBe(allowed ? 1 : 0);
  } finally { await proxy.close(); await trajectory.flush(); target.close(); await once(target, 'close'); await rm(root, { recursive: true, force: true }); }
});

it.skipIf(process.platform !== 'darwin')('permits the private Unix bridge while denying outside sockets and TCP binds', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-unix-')));
  const result = await runWorker({ executable: process.execPath, cwd: root, timeoutMs: 10000, maxOutputBytes: 65536,
    args: ['-e', `
      const net = require('node:net');
      const probe = address => new Promise(resolve => {
        const server = net.createServer();
        server.once('error', error => resolve(error.code));
        server.listen(address, () => server.close(() => resolve('allowed')));
      });
      (async () => {
        const socket = ${JSON.stringify(join(root, 'bridge.sock'))};
        const server = net.createServer(client => client.end('private-bridge'));
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
        const inside = await new Promise((resolve, reject) => {
          const client = net.connect(socket); let value = '';
          client.on('data', chunk => value += chunk); client.on('end', () => resolve(value)); client.on('error', reject);
        });
        await new Promise(resolve => server.close(resolve));
        console.log(JSON.stringify({ inside, outside: await probe(${JSON.stringify(`${root}-outside.sock`)}),
          tcp: await probe({ host: '127.0.0.1', port: 0 }) }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `] }, { writableRoots: [root], unixSocketRoots: [root] }, AbortSignal.timeout(15000));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ inside: 'private-bridge', outside: 'EPERM', tcp: 'EPERM' });
}, 20000);

it.skipIf(!['darwin', 'linux'].includes(process.platform))('denies direct worker sockets and filesystem writes while allowing the private scoped proxy', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => { hits++; res.end('lab-response'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No lab port');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-worker-')));
  const config = engagement({ scope: scope('localhost', address.port) });
  config.scope.targets[0]!.schemes = ['http']; config.scope.networks = ['127.0.0.1/32'];
  const scopes = new ScopeService(config.scope, async () => [{ address: '127.0.0.1', family: 4 }]);
  const redactor = new Redactor(), trajectories = new TrajectoryStore(join(root, 'trajectory'), config.id, redactor);
  const sessions = new EngagementService(config), session = id<'SessionId'>(); sessions.attach(session);
  const signal = AbortSignal.timeout(15000), proxy = new WorkerProxy(scopes, sessions, trajectories, redactor, session, 'target', signal);
  await proxy.start();
  const curl = (args: string[], brokered: boolean) => runWorker({ executable: '/usr/bin/curl', args: ['--max-time', '3', '--silent', '--show-error', ...args], cwd: root,
    timeoutMs: 5000, maxOutputBytes: 65536 }, { writableRoots: [root], ...(brokered ? { proxyPort: proxy.sandboxPort } : {}) }, signal);
  try {
    const direct = await curl([`http://127.0.0.1:${address.port}/`], false);
    expect(direct.exitCode).not.toBe(0); expect(hits).toBe(0);
    const allowed = await curl(['--noproxy', '', '--proxy', proxy.endpoint, `http://localhost:${address.port}/`], true);
    expect(allowed.exitCode, allowed.stderr).toBe(0); expect(allowed.stdout).toBe('lab-response'); expect(hits).toBe(1);
    const denied = await curl(['--noproxy', '', '--proxy', proxy.endpoint, 'http://outside.invalid/'], true);
    expect(denied.stdout).toContain('outside'); expect(hits).toBe(1);
    const write = await runWorker({ executable: '/bin/sh', args: ['-c', 'echo forbidden > /private/tmp/dsh-worker-outside-proof'], cwd: root,
      timeoutMs: 1000, maxOutputBytes: 4096 }, { writableRoots: [root] }, signal);
    expect(write.exitCode).not.toBe(0);
    await expect(readFile('/private/tmp/dsh-worker-outside-proof')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await trajectories.read(session)).map(event => event.type)).toContain('worker/connection');
  } finally { await proxy.close(); server.close(); await once(server, 'close'); }
}, 20000);

it('allows public passive research tunnels without granting active scope and exposes broker denials', async () => {
  const target = net.createServer(client => client.end('research fixture')); target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const address = target.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const root = await mkdtemp(join(tmpdir(), 'djupleita-passive-proxy-'));
  const config = engagement({ scope: { ...scope('target.example.test'), networks: ['127.0.0.1/32'], exclusions: ['excluded.example.test'] } });
  const scopes = new ScopeService(config.scope, async () => [{ address: '127.0.0.1', family: 4 }]);
  const redactor = new Redactor(), trajectory = new TrajectoryStore(join(root, 'events'), config.id, redactor);
  const session = id<'SessionId'>(), budget = new EngagementService(config); budget.attach(session);
  const connect = async (proxy: WorkerProxy, host: string) => {
    const endpoint = new URL(proxy.endpoint);
    return new Promise<string>((resolve, reject) => {
      const client = net.connect({ host: endpoint.hostname, port: Number(endpoint.port) }); let result = '';
      client.on('error', reject); client.on('data', chunk => { result += chunk; }); client.on('end', () => resolve(result));
      client.on('connect', () => client.write(`CONNECT ${host}:${address.port} HTTP/1.1\r\nHost: ${host}:${address.port}\r\nProxy-Authorization: Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}\r\n\r\n`));
    });
  };
  const proxies: WorkerProxy[] = [];
  try {
    for (const [access, host, allowed] of [['read', 'research.example.test', true], ['active', 'research.example.test', false], ['read', 'excluded.example.test', false]] as const) {
      const proxy = new WorkerProxy(scopes, budget, trajectory, redactor, session, 'target', AbortSignal.timeout(5000), access); proxies.push(proxy); await proxy.start();
      expect(await connect(proxy, host)).toContain(allowed ? '200 Connection Established' : '403 Forbidden');
      if (allowed) expect(() => proxy.assertHealthy()).not.toThrow(); else expect(() => proxy.assertHealthy()).toThrow();
    }
  } finally { for (const proxy of proxies) await proxy.close(); await trajectory.flush(); target.close(); await once(target, 'close'); await rm(root, { recursive: true, force: true }); }
});


it.skipIf(!['darwin', 'linux'].includes(process.platform))('drains large worker output independently of late relay stdio initialization and retains the output cap', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'djupleita-worker-output-')));
  const setup = join(root, 'late-stdio.cjs'), program = join(root, 'burst.cjs');
  // Reproduce Node initializing its relay streams after the CLI has inherited
  // stdout. Shared descriptors become nonblocking and synchronous CLIs hit EAGAIN.
  await writeFile(setup, `if (process.argv[1] === '/run/djupleita/relay.cjs') setTimeout(() => { void process.stdout; void process.stderr; }, 50).unref();`);
  await writeFile(program, `const fs = require('node:fs'); setTimeout(() => {
    const chunk = Buffer.alloc(4096, 'x');
    for (let i = 0; i < 1024; i++) fs.writeSync(1, chunk);
    for (let i = 0; i < 256; i++) fs.writeSync(2, chunk);
  }, 150);`);
  const bridge = net.createServer(client => client.end()); bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  const address = bridge.address(); if (!address || typeof address === 'string') throw new Error('No fixture port');
  const command = { executable: process.execPath, args: [program], cwd: root, timeoutMs: 10000,
    maxOutputBytes: 6 * 1024 * 1024, env: { NODE_OPTIONS: `--require=${setup}` } };
  try {
    const result = await runWorker(command, { writableRoots: [root], proxyPort: address.port }, AbortSignal.timeout(15000));
    expect(result.exitCode, result.stderr.slice(0, 300)).toBe(0);
    expect(result.stdout).toBe('x'.repeat(4 * 1024 * 1024)); expect(result.stderr).toBe('x'.repeat(1024 * 1024));
    await expect(runWorker({ ...command, maxOutputBytes: 65536 }, { writableRoots: [root], proxyPort: address.port }, AbortSignal.timeout(15000))).rejects.toMatchObject({ code: 'WORKER_OUTPUT' });
  } finally { bridge.close(); await once(bridge, 'close'); await rm(root, { recursive: true, force: true }); }
}, 30000);
