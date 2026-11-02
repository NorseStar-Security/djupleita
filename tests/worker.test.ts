import { it, expect } from 'vitest';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, realpath, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWorker, WorkerProxy } from '../packages/worker/src/index.ts';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, scope } from './fixtures.ts';

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
