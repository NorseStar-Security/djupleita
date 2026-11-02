/** OS adapters for bounded workers. Linux exposes only an optional broker socket. */
import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { access, chmod, mkdtemp, realpath, rm, writeFile, lstat, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { PentestError } from '@dsh-pentest/contracts';
import type { WorkerCommand } from './index.ts';
import { sandboxProfile } from './seatbelt.ts';
import type { SandboxOptions } from './seatbelt.ts';

export interface SandboxLaunch { executable: string; args: string[]; close(): Promise<void> }
/** Linux system runtimes already have specific mounts; a prefix must not expose all SDKs. */
export function runtimeReadRoots(prefixes: string[], platform: NodeJS.Platform = process.platform): string[] {
  return [...new Set(prefixes.filter(path => platform !== 'linux' || path !== '/usr'))];
}
export function workerEnvironment(command: Pick<WorkerCommand, 'cwd' | 'env'>): Record<string, string> {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: command.cwd, TMPDIR: command.cwd,
    LANG: process.platform === 'linux' ? 'C.UTF-8' : 'en_US.UTF-8', ...command.env };
}
function validate(options: SandboxOptions): void {
  for (const path of [...options.writableRoots, ...(options.readableRoots ?? []), ...(options.unixSocketRoots ?? [])]) {
    if (!isAbsolute(path) || path === '/' || path.includes('\0')) throw new PentestError('SANDBOX_ROOT', 'Worker roots must be absolute, bounded directories');
  }
  if (options.proxyPort !== undefined && (!Number.isInteger(options.proxyPort) || options.proxyPort < 1 || options.proxyPort > 65535))
    throw new PentestError('SANDBOX_PORT', 'Invalid broker port');
}

// Runs inside the isolated network namespace. The host endpoint is a single
// mounted Unix socket; it can reach only the already-authorized broker port.
const relayProgram = String.raw`
const net = require('node:net');
const { spawn } = require('node:child_process');
const [port, executable, ...args] = process.argv.slice(2);
const sockets = new Set();
const server = net.createServer(client => {
  const upstream = net.connect('/run/djupleita/proxy.sock');
  for (const socket of [client, upstream]) { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); }
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close); upstream.on('error', close);
  client.on('close', close); upstream.on('close', close);
  client.pipe(upstream); upstream.pipe(client);
});
server.maxConnections = 256;
server.on('error', () => { process.stderr.write('Linux broker bridge failed\n'); process.exit(125); });
server.listen(Number(port), '127.0.0.1', () => {
  const child = spawn(executable, args, { stdio: 'inherit', env: process.env });
  const finish = code => { for (const socket of sockets) socket.destroy(); server.close(() => process.exit(code)); };
  child.on('error', () => finish(126)); child.on('exit', code => finish(code ?? 1));
});
`;

async function brokerBridge(port: number): Promise<{ socket: string; program: string; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-proxy-'));
  const socket = join(root, 'broker.sock'), program = join(root, 'relay.cjs');
  const sockets = new Set<Socket>(), server = createServer(client => {
    if (sockets.size >= 512) { client.destroy(); return; }
    const upstream = connect({ host: '127.0.0.1', port });
    const close = () => { client.destroy(); upstream.destroy(); };
    for (const item of [client, upstream]) {
      sockets.add(item); item.once('close', () => sockets.delete(item));
      item.on('error', close); item.on('close', close); item.setTimeout(300000, close);
    }
    client.pipe(upstream); upstream.pipe(client);
  });
  server.maxConnections = 256;
  server.on('error', () => { for (const item of sockets) item.destroy(); });
  const close = async () => {
    for (const item of sockets) item.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  try {
    await writeFile(program, relayProgram, { mode: 0o600, flag: 'wx' });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.removeListener('error', reject); resolve(); }); });
    await chmod(socket, 0o600);
    return { socket, program, close };
  } catch (error) { await close(); throw error; }
}

// A read-only bind still permits connecting to a filesystem Unix socket. Mask
// existing host sockets unless that private IPC root was explicitly granted.
// Symlinks are not traversed; their destinations must have a separate mount grant.
async function socketMasks(roots: string[], allowed: string[], signal: AbortSignal): Promise<{ sockets: string[]; privateDirectories: string[] }> {
  const sockets = new Set<string>(), privateDirectories = new Set<string>(), visited = new Set<string>(); let entries = 0;
  type Input = { path: string; info?: { isSocket(): boolean; isDirectory(): boolean } };
  const pending: Input[] = roots.map(path => ({ path }));
  const permitted = (path: string) => allowed.some(root => { const tail = relative(root, path); return tail === '' || !tail.startsWith('..') && !isAbsolute(tail); });
  const inspect = async ({ path, info }: Input): Promise<void> => {
    signal.throwIfAborted(); if (visited.has(path) || permitted(path)) return; visited.add(path);
    info ??= await lstat(path);
    if (info.isSocket()) sockets.add(path);
    else if (info.isDirectory()) {
      const children = await readdir(path, { withFileTypes: true }).catch(error => {
        if (error.code !== 'EACCES') throw error;
        // An unlistable system directory may contain host IPC. Hide it entirely.
        privateDirectories.add(path); return [];
      });
      entries += children.length;
      if (entries > 1000000) throw new PentestError('SANDBOX_INPUTS', 'Sandbox input tree exceeds its entry limit; select narrower roots');
      for (const child of children) if (child.isDirectory() || child.isSocket()) pending.push({ path: join(path, child.name), info: child });
    }
  };
  // Large host /usr trees must not delay every worker behind serial readdir calls.
  // Bound concurrent I/O while retaining the complete socket inventory and entry limit.
  for (let next = 0; next < pending.length;) {
    signal.throwIfAborted();
    const batch = pending.slice(next, next + 32); next += batch.length;
    await Promise.all(batch.map(inspect));
  }
  return { sockets: [...sockets], privateDirectories: [...privateDirectories] };
}

/** Build a Linux filesystem from an empty root. No home, host /tmp or D-Bus is mounted. */
async function linuxProfile(options: SandboxOptions, executable: string, signal: AbortSignal): Promise<string[]> {
  const args = ['--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/dev/shm'];
  const mounted: { source: string; destination: string; writable: boolean }[] = [];
  const triplet = process.arch === 'x64' ? 'x86_64-linux-gnu' : process.arch === 'arm64' ? 'aarch64-linux-gnu' : undefined;
  const multiarch = triplet && await access(`/usr/lib/${triplet}`).then(() => true, () => false);
  const libraries = multiarch ? [`/usr/lib/${triplet}`, `/lib/${triplet}`, '/usr/lib/locale', '/usr/lib/ssl', '/usr/lib/file',
    '/lib/ld-linux-aarch64.so.1', '/usr/lib/ld-linux-aarch64.so.1'] : ['/usr/lib', '/lib'];
  if (multiarch) {
    for (const base of ['/usr/lib', '/lib']) {
      const names = await readdir(base);
      libraries.push(...names.filter(name => /^python3(?:\.\d+)?$/.test(name)).map(name => join(base, name)));
    }
  }
  const optional = ['/usr/bin', '/usr/sbin', ...libraries, '/usr/lib64', '/usr/libexec', '/bin', '/sbin', '/lib64',
    '/usr/share/ca-certificates', '/usr/share/fonts', '/usr/share/fontconfig', '/usr/share/glib-2.0', '/usr/share/X11',
    '/usr/share/zoneinfo', '/usr/share/file', '/usr/share/misc', '/etc/fonts', '/etc/ld.so.cache', '/etc/ssl', '/etc/pki',
    '/etc/alternatives', '/etc/nsswitch.conf', '/etc/passwd', '/etc/group', '/etc/localtime'];
  for (const path of optional) {
    if (await access(path).then(() => true, () => false)) mounted.push({ source: await realpath(path), destination: path, writable: false });
  }
  const mounts = async (paths: string[], writable: boolean) => {
    for (const path of [...new Set(paths)]) {
      const canonical = await realpath(path);
      if (canonical === '/') throw new PentestError('SANDBOX_ROOT', 'Worker roots cannot resolve to the filesystem root');
      mounted.push({ source: canonical, destination: path, writable });
      if (canonical !== path) mounted.push({ source: canonical, destination: canonical, writable });
    }
  };
  await mounts([executable, ...(options.readableRoots ?? [])], false);
  await mounts(options.writableRoots, true);
  const allowed = await Promise.all((options.unixSocketRoots ?? []).map(path => realpath(path)));
  const masks = await socketMasks([...new Set(mounted.map(mount => mount.source))], allowed, signal);
  for (const mount of mounted) {
    args.push(mount.writable ? '--bind' : '--ro-bind', mount.source, mount.destination);
    const destination = (path: string) => {
      const tail = relative(mount.source, path);
      return tail === '' || !tail.startsWith('..') && !isAbsolute(tail) ? join(mount.destination, tail) : undefined;
    };
    // Mask each view before a later parent grant can cover an alias with a symlink.
    for (const socket of masks.sockets) { const path = destination(socket); if (path) args.push('--ro-bind', '/dev/null', path); }
    for (const directory of masks.privateDirectories) { const path = destination(directory); if (path) args.push('--tmpfs', path, '--remount-ro', path); }
  }
  return args;
}

/** A missing or unusable OS backend always fails closed. Never returns an unconfined command. */
export async function prepareSandbox(command: Pick<WorkerCommand, 'executable' | 'args' | 'cwd'>, options: SandboxOptions,
  signal: AbortSignal, platform: NodeJS.Platform = process.platform): Promise<SandboxLaunch> {
  validate(options); signal.throwIfAborted();
  if (platform === 'darwin') return { executable: '/usr/bin/sandbox-exec', args: ['-p', sandboxProfile(options), command.executable, ...command.args], close: async () => {} };
  if (platform !== 'linux') throw new PentestError('SANDBOX_PLATFORM', 'Managed workers support macOS and Linux; native Windows is unsupported');
  try { await access('/usr/bin/bwrap', constants.X_OK); }
  catch { throw new PentestError('SANDBOX_UNAVAILABLE', 'Linux workers require /usr/bin/bwrap (bubblewrap) and enabled unprivileged user namespaces'); }
  const args = await linuxProfile(options, command.executable, signal);
  args.push('--chdir', command.cwd);
  if (options.proxyPort === undefined) return { executable: '/usr/bin/bwrap', args: [...args, '--', command.executable, ...command.args], close: async () => {} };
  const bridge = await brokerBridge(options.proxyPort);
  try {
    signal.throwIfAborted();
    // The relay uses the same Node runtime as the host, without its environment.
    const node = await realpath(process.execPath);
    args.push('--ro-bind', node, node, '--dir', '/run/djupleita', '--ro-bind', bridge.socket, '/run/djupleita/proxy.sock',
      '--ro-bind', bridge.program, '/run/djupleita/relay.cjs', '--', node, '/run/djupleita/relay.cjs', String(options.proxyPort), command.executable, ...command.args);
    return { executable: '/usr/bin/bwrap', args, close: bridge.close };
  } catch (error) { await bridge.close(); throw error; }
}
