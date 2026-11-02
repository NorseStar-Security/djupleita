/** Confined managed processes and an authenticated, DNS-pinned egress proxy. */
import { prepareSandbox, workerEnvironment } from './platform.ts';
export { prepareSandbox, workerEnvironment } from './platform.ts';
export type { SandboxLaunch } from './platform.ts';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { PentestError } from '@dsh-pentest/contracts';
import type { Purpose, SessionId } from '@dsh-pentest/contracts';
import type { ScopeService } from '@dsh-pentest/scope';
import { matchesHost } from '@dsh-pentest/scope';
import type { EngagementService } from '@dsh-pentest/engagement';
import type { TrajectoryStore, Redactor } from '@dsh-pentest/trajectory';

export { sandboxProfile } from './seatbelt.ts';
export type { SandboxOptions } from './seatbelt.ts';
import type { SandboxOptions } from './seatbelt.ts';
export interface WorkerCommand { executable: string; args: string[]; cwd: string; env?: Record<string, string>; timeoutMs: number; maxOutputBytes: number }
export interface WorkerResult { stdout: string; stderr: string; exitCode: number }
export async function validateExecutable(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new PentestError('WORKER_EXECUTABLE', 'Configure an absolute executable path; PATH lookup is not permitted');
  const resolved = await realpath(path); await access(resolved, constants.X_OK); return resolved;
}
/** No shell, no inherited credentials, bounded output, and process-group cancellation. */
export async function runWorker(command: WorkerCommand, options: SandboxOptions, signal: AbortSignal): Promise<WorkerResult> {
  if (command.timeoutMs < 1 || command.maxOutputBytes < 1) throw new PentestError('WORKER_LIMITS', 'Worker limits must be positive');
  signal.throwIfAborted();
  await validateExecutable(command.executable);
  // Python determines its virtual environment from the invoked symlink path.
  // Keep that absolute operator-selected path after validating its target.
  const launch = await prepareSandbox(command, options, signal);
  try {
    const child = spawn(launch.executable, launch.args, {
      cwd: command.cwd, env: workerEnvironment(command), detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return await new Promise<WorkerResult>((resolve, reject) => {
      let stdout = '', stderr = '', size = 0, failure: Error | undefined;
      const kill = (error: Error) => {
        failure ??= error;
        if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      };
      const aborted = () => kill(new PentestError('WORKER_CANCELLED', 'Managed worker was cancelled'));
      const timer = setTimeout(() => kill(new PentestError('WORKER_TIMEOUT', 'Managed worker exceeded its deadline')), command.timeoutMs);
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
      const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        size += chunk.length;
        if (size > command.maxOutputBytes) return kill(new PentestError('WORKER_OUTPUT', 'Managed worker exceeded its output limit'));
        if (stream === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', aborted); };
      child.once('error', error => { cleanup(); reject(error); });
      child.once('close', code => { cleanup(); if (failure) reject(failure); else resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    });
  } finally { await launch.close(); }
}

/** A private worker proxy. CONNECT grants require whole-host scope because TLS paths are opaque. */
export class WorkerProxy {
  private readonly server = createServer();
  private readonly sockets = new Set<net.Socket>();
  private readonly token = randomBytes(32).toString('hex');
  private port = 0;
  constructor(private readonly scope: ScopeService, private readonly engagement: EngagementService,
    private readonly trajectory: TrajectoryStore, private readonly redactor: Redactor,
    private readonly session: SessionId, private readonly purpose: Purpose, private readonly signal: AbortSignal) {
    redactor.register(this.token);
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('request', (request, response) => { void (async () => {
      if (!this.auth(request.headers['proxy-authorization'])) { response.writeHead(407); response.end(); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') throw new PentestError('PROXY_METHOD', 'Recon proxy permits GET and HEAD only');
      const grant = await this.scope.authorize({ url: request.url ?? '', purpose: this.purpose }, this.signal);
      const reservation = await this.engagement.acquire(this.signal);
      try {
        await this.record(grant.url.href);
        const address = grant.addresses[0]!;
        const headers = { ...request.headers }; delete headers['proxy-authorization']; delete headers['proxy-connection'];
        headers.host = grant.url.host;
        const upstream = (grant.url.protocol === 'https:' ? https : http).request(grant.url, {
          method: request.method, headers, signal: this.signal, agent: false, family: address.family,
          lookup: (_name, _options, callback) => callback(null, address.address, address.family),
        }, incoming => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
        upstream.once('error', () => { response.destroy(); });
        await new Promise<void>((resolve, reject) => { response.once('finish', resolve); response.once('close', resolve); upstream.once('error', reject); upstream.end(); });
      } finally { reservation.release(); }
    })().catch(error => { if (!response.headersSent) response.writeHead(403); response.end(this.redactor.text(error instanceof Error ? error.message : 'Proxy denied')); }); });
    this.server.on('connect', (request, client, head) => { void (async () => {
      if (!this.auth(request.headers['proxy-authorization'])) throw new PentestError('PROXY_AUTH', 'Proxy authentication required');
      const authority = request.url ?? '';
      if (!/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\]):[0-9]+$/i.test(authority)) throw new PentestError('PROXY_AUTHORITY', 'Invalid CONNECT authority');
      const grant = await this.scope.authorize({ url: `https://${authority}/`, purpose: this.purpose }, this.signal);
      const rules = this.purpose === 'target' ? this.scope.scope.targets : this.scope.scope.services[this.purpose];
      if (!rules.some(rule => rule.pathPrefixes.includes('/') && matchesHost(grant.url.hostname, rule.host)
        && rule.schemes.includes('https') && rule.ports.includes(Number(grant.url.port || 443)))) {
        throw new PentestError('PROXY_PATH', 'TLS tunnels require whole-host path scope');
      }
      const reservation = await this.engagement.acquire(this.signal);
      await this.record(grant.url.href);
      const upstream = net.connect({ host: grant.addresses[0]!.address, port: Number(grant.url.port || 443), signal: this.signal });
      this.sockets.add(upstream);
      let released = false;
      const close = () => { if (!released) { released = true; reservation.release(); } upstream.destroy(); client.destroy(); this.sockets.delete(upstream); };
      upstream.once('error', close); client.once('error', close); client.once('close', close); upstream.once('close', close);
      upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) upstream.write(head); client.pipe(upstream); upstream.pipe(client); });
    })().catch(() => { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }); });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new PentestError('PROXY_BIND', 'Unable to bind worker proxy');
    this.port = address.port;
  }
  get endpoint(): string { if (!this.port) throw new PentestError('PROXY_BIND', 'Worker proxy is not listening'); return `http://worker:${this.token}@127.0.0.1:${this.port}`; }
  get sandboxPort(): number { return this.port; }
  async close(): Promise<void> { for (const socket of this.sockets) socket.destroy(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
  private auth(value: string | undefined): boolean { return value === `Basic ${Buffer.from(`worker:${this.token}`).toString('base64')}`; }
  private async record(url: string): Promise<void> { await this.trajectory.append(this.session, 'worker/connection', this.redactor.json({ url, purpose: this.purpose, scopeVersion: this.scope.version })); }
}
