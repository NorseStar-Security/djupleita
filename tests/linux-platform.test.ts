import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareSandbox, runWorker } from '../packages/worker/src/index.ts';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), 'djupleita-platform-'))); roots.push(root); return root; }

it('rejects unsupported platforms and unbounded filesystem grants before launching', async () => {
  const command = { executable: '/bin/sh', args: [], cwd: '/tmp' }, signal = new AbortController().signal;
  await expect(prepareSandbox(command, { writableRoots: ['/tmp'] }, signal, 'win32')).rejects.toMatchObject({ code: 'SANDBOX_PLATFORM' });
  for (const path of ['/', 'relative', '/tmp/\0invalid']) {
    await expect(prepareSandbox(command, { writableRoots: [path] }, signal)).rejects.toMatchObject({ code: 'SANDBOX_ROOT' });
  }
});

it.skipIf(process.platform !== 'linux')('isolates reads, host writes, namespaces and environment while preserving selected files', async () => {
  const root = await directory(), outside = await directory();
  await writeFile(join(outside, 'private'), 'private fixture'); await writeFile(join(outside, 'selected'), 'selected fixture');
  vi.stubEnv('DSH_PLATFORM_CANARY', 'inherited fixture must stay outside');
  const result = await runWorker({ executable: process.execPath, cwd: root, args: ['-e', `
    const fs = require('node:fs');
    let blocked; try { fs.readFileSync(${JSON.stringify(join(outside, 'private'))}); } catch { blocked = true; }
    fs.writeFileSync(${JSON.stringify(join(root, 'allowed'))}, 'allowed');
    fs.writeFileSync('/tmp/namespace-only', 'private tmp');
    console.log(JSON.stringify({ blocked, selected: fs.readFileSync(${JSON.stringify(join(outside, 'selected'))}, 'utf8'),
      home: process.env.HOME, inherited: process.env.DSH_PLATFORM_CANARY ?? null,
      userNamespace: fs.readFileSync('/proc/self/uid_map', 'utf8').trim() }));
  `], timeoutMs: 5000, maxOutputBytes: 8192 }, { writableRoots: [root], readableRoots: [join(outside, 'selected')] }, new AbortController().signal);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ blocked: true, selected: 'selected fixture', home: root, inherited: null });
  expect(await readFile(join(root, 'allowed'), 'utf8')).toBe('allowed');
  await expect(readFile('/tmp/namespace-only')).rejects.toMatchObject({ code: 'ENOENT' });
});

it.skipIf(process.platform !== 'linux')('kills sandbox descendants on cancellation and enforces output limits', async () => {
  const root = await directory(), heartbeat = join(root, 'heartbeat');
  const signal = new AbortController();
  const worker = runWorker({ executable: process.execPath, cwd: root, args: ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20)`)}], { stdio: 'ignore' });
    setInterval(() => {}, 1000);
  `], timeoutMs: 10000, maxOutputBytes: 8192 }, { writableRoots: [root] }, signal.signal);
  try {
    await expect.poll(() => readFile(heartbeat).then(() => true, () => false), { timeout: 10000 }).toBe(true);
    signal.abort(); await expect(worker).rejects.toMatchObject({ code: 'WORKER_CANCELLED' });
    const before = await readFile(heartbeat, 'utf8'); await delay(150);
    expect(await readFile(heartbeat, 'utf8')).toBe(before);
  } finally { signal.abort(); await worker.catch(() => undefined); }
  await expect(runWorker({ executable: process.execPath, cwd: root, args: ['-e', "console.log('x'.repeat(100000))"],
    timeoutMs: 5000, maxOutputBytes: 64 }, { writableRoots: [root] }, new AbortController().signal)).rejects.toMatchObject({ code: 'WORKER_OUTPUT' });
});

it.skipIf(process.platform !== 'linux')('masks existing host Unix sockets through input aliases unless private IPC is explicitly granted', async () => {
  const root = await directory(), input = await directory(), alias = `${root}/selected-inputs`, nested = 'nested/inputs/private', socket = join(input, nested, 'host.sock');
  await mkdir(join(input, nested), { recursive: true });
  await symlink(input, alias); let hits = 0;
  const server = createServer(client => { hits++; client.end('private fixture'); });
  server.listen(socket); await once(server, 'listening');
  const command = { executable: process.execPath, cwd: root, args: ['-e', `
    const net = require('node:net');
    Promise.all(${JSON.stringify([socket, join(alias, nested, 'host.sock')])}.map(path => new Promise(resolve => {
      const client = net.connect(path); let output = '';
      client.on('data', data => output += data); client.on('error', () => resolve('blocked'));
      client.on('end', () => resolve(output));
    }))).then(result => console.log(JSON.stringify(result)));
  `], timeoutMs: 5000, maxOutputBytes: 8192 };
  try {
    const blocked = await runWorker(command, { writableRoots: [root], readableRoots: [alias] }, new AbortController().signal);
    expect(blocked.exitCode, blocked.stderr).toBe(0); expect(JSON.parse(blocked.stdout)).toEqual(['blocked', 'blocked']); expect(hits).toBe(0);
    const granted = await runWorker(command, { writableRoots: [root], readableRoots: [alias], unixSocketRoots: [input] }, new AbortController().signal);
    expect(granted.exitCode, granted.stderr).toBe(0); expect(JSON.parse(granted.stdout)).toEqual(['private fixture', 'private fixture']); expect(hits).toBe(2);
    const shell = await runWorker({ ...command, executable: '/bin/sh', args: ['-c', 'printf shell-fixture'] }, { writableRoots: [root] }, new AbortController().signal);
    expect(shell.exitCode, shell.stderr).toBe(0); expect(shell.stdout).toBe('shell-fixture');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
