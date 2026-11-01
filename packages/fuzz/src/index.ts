/** Typed ffuf URL fuzzing. Every generated request crosses the HTTP broker individually. */
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { id, PentestError } from '@dsh-pentest/contracts';
import type { IdentityId, Json, SessionId } from '@dsh-pentest/contracts';
import { HttpInputSchema } from '@dsh-pentest/http';
import type { HttpBroker, HttpResult } from '@dsh-pentest/http';
import type { EngagementService } from '@dsh-pentest/engagement';
import type { CrawlService } from '@dsh-pentest/crawl';
import type { Redactor, TrajectoryStore, EvidenceStore } from '@dsh-pentest/trajectory';
import { runWorker, validateExecutable } from '@dsh-pentest/worker';
export { installFfuf } from './install.ts';

const word = z.string().min(1).max(512).refine(value => !/[\r\n\0]/.test(value), 'Wordlist entries cannot contain newlines or NUL');
const statuses = z.array(z.number().int().min(100).max(599)).max(500);
export const FuzzConfigSchema = z.object({
  binary: z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).optional(),
  wordlists: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/), z.string()).default({}),
  timeoutMs: z.number().int().min(1000).max(1800000).default(300000),
});
export type FuzzConfig = z.infer<typeof FuzzConfigSchema>;
export const FuzzInputSchema = z.object({
  url: z.url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash
      && !/^https?:\/\/[^/?#]*FUZZ/.test(value) && /FUZZ/.test(url.pathname + url.search);
  }, 'Use FUZZ in an HTTP(S) URL path or query, with a fixed host and no credentials or fragment'),
  method: HttpInputSchema.shape.method.default('GET'),
  headers: z.record(z.string(), z.string()).default({}), body: z.string().max(65536).optional(),
  identityId: z.string().uuid().optional(),
  words: z.array(word).min(1).max(10000).optional(),
  wordlistId: z.string().regex(/^[a-zA-Z0-9_-]+$/).default('common'),
  matchStatus: z.union([z.literal('all'), statuses.min(1)]).default([200, 201, 202, 204, 301, 302, 307, 308, 401, 403, 405, 500]),
  filterStatus: statuses.default([]), filterSize: z.array(z.number().int().min(0)).max(100).default([]),
  filterWords: z.array(z.number().int().min(0)).max(100).default([]), filterLines: z.array(z.number().int().min(0)).max(100).default([]),
  rate: z.number().positive().max(1000).default(5), concurrency: z.number().int().min(1).max(20).default(2),
  maxResults: z.number().int().min(1).max(500).default(100),
}).strict();
export type FuzzInput = z.infer<typeof FuzzInputSchema>;
export const COMMON_WORDS = ['admin', 'api', 'assets', 'auth', 'backup', 'config', 'dashboard', 'debug', 'docs',
  'health', 'images', 'index.html', 'login', 'logout', 'metrics', 'robots.txt', 'static', 'status', 'test', 'uploads', 'users', 'v1', 'v2'];

/** A private HTTP gateway keeps TLS, scope, identities and byte budgets in the broker. */
export class FuzzGateway {
  private readonly server = createServer();
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Set<Promise<void>>();
  private readonly closed = new AbortController();
  private readonly prefix = `/${randomBytes(32).toString('hex')}`;
  private port = 0;
  attempts = 0;
  successful = 0;
  readonly responses = new Map<string, HttpResult>();
  readonly errors: { url: string; message: string }[] = [];
  errorCount = 0;
  constructor(private readonly input: FuzzInput, private readonly maxRequests: number, private readonly broker: HttpBroker,
    private readonly session: SessionId, private readonly signal: AbortSignal, private readonly redactor: Redactor) {
    redactor.register(this.prefix);
    this.server.on('connection', socket => { this.sockets.add(socket); socket.on('close', () => this.sockets.delete(socket)); });
    this.server.on('request', (request, response) => {
      const pending = this.handle(request, response); this.pending.add(pending);
      void pending.finally(() => this.pending.delete(pending));
    });
  }
  async start(): Promise<void> {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('ffuf gateway failed to bind');
    this.port = address.port;
  }
  get sandboxPort(): number { return this.port; }
  get template(): string { const url = new URL(this.input.url); return `http://127.0.0.1:${this.port}${this.prefix}${url.pathname}${url.search}`; }
  target(local: string): string {
    const url = new URL(local, `http://127.0.0.1:${this.port}`);
    if (url.origin !== `http://127.0.0.1:${this.port}` || !url.pathname.startsWith(`${this.prefix}/`)) throw new Error('Invalid ffuf gateway route');
    // Concatenation prevents a //path payload from selecting a different authority.
    return new URL(new URL(this.input.url).origin + url.pathname.slice(this.prefix.length) + url.search).href;
  }
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let url = this.input.url;
    try {
      const signal = AbortSignal.any([this.signal, this.closed.signal]); signal.throwIfAborted();
      url = this.target(request.url ?? '');
      if (++this.attempts > this.maxRequests) throw new PentestError('FUZZ_REQUEST_LIMIT', 'ffuf generated more requests than its bounded wordlist permits');
      if (request.method !== this.input.method) throw new Error('Unexpected ffuf request method');
      // The adapter supplies fixed headers/body. Worker-controlled routing and cookies never pass through.
      const result = await this.broker.deliver({ url, method: this.input.method, headers: this.input.headers,
        ...(this.input.body === undefined ? {} : { body: this.input.body }),
        ...(this.input.identityId ? { identityId: this.input.identityId as IdentityId } : {}) }, this.session, signal, undefined, {}, false);
      this.successful++;
      this.responses.set(url, { ...result.result, body: '' });
      // Return redacted bytes only; do not hand target cookies, redirects or credentials to ffuf.
      const body = Buffer.from(result.result.body);
      response.writeHead(result.result.status, { 'content-type': result.result.headers['content-type'] ?? 'application/octet-stream', 'content-length': body.length });
      response.end(this.input.method === 'HEAD' ? undefined : body);
    } catch (error) {
      const message = this.redactor.text(error instanceof Error ? error.message : 'Fuzz request failed');
      this.errorCount++;
      if (this.errors.length < 50) this.errors.push({ url: this.redactor.text(url), message });
      // An error must never become a synthetic 403/200 discovery in ffuf output.
      response.destroy();
    }
  }
  async close(): Promise<void> {
    this.closed.abort(); for (const socket of this.sockets) socket.destroy();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
    await Promise.allSettled(this.pending);
  }
}

export class FuzzService {
  constructor(private readonly config: FuzzConfig, private readonly root: string, private readonly engagement: EngagementService,
    private readonly http: (session: SessionId) => HttpBroker, private readonly crawl: (session: SessionId) => CrawlService,
    private readonly evidence: EvidenceStore, private readonly trajectory: TrajectoryStore, private readonly redactor: Redactor) {}
  private async binary(): Promise<string> {
    const binary = this.config.binary;
    if (!binary) throw new PentestError('FFUF_MISSING', 'ffuf is not installed. Open Plugins → ffuf fuzzing → Tool setup → Install ffuf, or run pnpm setup:tools --only ffuf and Load local setup.');
    const path = await validateExecutable(binary.path);
    if (createHash('sha256').update(await readFile(path)).digest('hex') !== binary.sha256) throw new PentestError('FFUF_INTEGRITY', 'ffuf executable does not match its operator-pinned SHA-256');
    return path;
  }
  async doctor(): Promise<Json> {
    try { return { ready: true, path: await this.binary(), wordlists: ['common', ...Object.keys(this.config.wordlists)] }; }
    catch (error) { return { ready: false, reason: error instanceof Error ? error.message : 'Unavailable' }; }
  }
  private async words(input: FuzzInput): Promise<string[]> {
    if (input.words) return [...new Set(input.words)];
    const path = this.config.wordlists[input.wordlistId];
    if (!path && input.wordlistId === 'common') return [...COMMON_WORDS];
    if (!path || !isAbsolute(path)) throw new PentestError('FUZZ_WORDLIST', 'Choose common, supply words, or configure an absolute wordlist path under an owner-defined ID.');
    if ((await stat(path)).size > 2 * 1024 * 1024) throw new PentestError('FUZZ_WORDLIST', 'Wordlist exceeds 2 MiB; select a smaller list.');
    const lines = (await readFile(path, 'utf8')).split(/\r?\n/).filter(line => line.length && !line.startsWith('#'));
    return [...new Set(z.array(word).min(1).max(10000).parse(lines))];
  }
  async run(raw: FuzzInput, session: SessionId, signal: AbortSignal): Promise<Json> {
    const input = FuzzInputSchema.parse(raw), executable = await this.binary(), words = await this.words(input);
    const budget = this.engagement.engagement.budget, remaining = this.engagement.snapshot().remainingRequests;
    if (words.length > remaining) throw new PentestError('FUZZ_REQUEST_LIMIT', `Wordlist has ${words.length} entries but only ${remaining} requests remain. Use a smaller list.`);
    const directory = join(this.root, id<'FuzzRunId'>()); await mkdir(directory, { recursive: true, mode: 0o700 });
    const cwd = await realpath(directory), path = join(cwd, 'words.txt'); await writeFile(path, words.join('\n') + '\n', { mode: 0o600 });
    const gateway = new FuzzGateway(input, words.length, this.http(session), session, signal, this.redactor);
    await gateway.start();
    const rate = Math.min(input.rate, budget.requestsPerSecond), concurrency = Math.min(input.concurrency, budget.concurrency);
    const seconds = Math.max(1, Math.ceil(this.config.timeoutMs / 1000));
    const args = ['-u', gateway.template, '-w', path, '-X', input.method, '-json', '-s', '-noninteractive', '-mc',
      Array.isArray(input.matchStatus) ? input.matchStatus.join(',') : 'all', '-rate', String(Math.max(1, Math.floor(rate))),
      '-t', String(concurrency), '-maxtime', String(seconds), '-timeout', String(seconds), '-scrapers', 'none'];
    for (const [flag, values] of [['-fc', input.filterStatus], ['-fs', input.filterSize], ['-fw', input.filterWords], ['-fl', input.filterLines]] as const) {
      if (values.length) args.push(flag, values.join(','));
    }
    try {
      await this.trajectory.append(session, 'fuzz/start', this.redactor.json({ url: input.url, method: input.method, wordlistId: input.words ? 'inline' : input.wordlistId,
        words: words.length, rate, concurrency, identityId: input.identityId ?? null }));
      let stdout = '', stderr = '', exitCode = -1, failure: string | undefined;
      try {
        const result = await runWorker({ executable, args, cwd, timeoutMs: this.config.timeoutMs + 1000, maxOutputBytes: 16 * 1024 * 1024,
          env: { XDG_CONFIG_HOME: cwd, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', NO_PROXY: '*' } },
          { writableRoots: [cwd], readableRoots: [executable], proxyPort: gateway.sandboxPort }, signal);
        ({ stdout, stderr, exitCode } = result);
      } catch (error) { failure = this.redactor.text(error instanceof Error ? error.message : 'ffuf worker failed'); }
      const matches: Json[] = []; let invalidRecords = 0, queued = 0;
      for (const line of stdout.split('\n').filter(Boolean)) {
        try {
          const record = z.object({ url: z.string(), status: z.number(), length: z.number(), words: z.number(), lines: z.number() }).parse(JSON.parse(line));
          const response = gateway.responses.get(gateway.target(record.url));
          if (!response || record.status !== response.status) throw new Error('No matching broker evidence');
          const candidate = { url: response.url, source: 'fuzz' as const, depth: 0, score: 0, ...(input.identityId ? { identityId: input.identityId as IdentityId } : {}) };
          this.crawl(session).record(response, candidate);
          queued += this.crawl(session).observe([response.url], 'fuzz', { ...candidate, score: 0 }, response.evidence.id);
          matches.push(this.redactor.json({ url: response.url, status: response.status, length: record.length, words: record.words,
            lines: record.lines, evidence: response.evidence, identityId: input.identityId ?? null }));
        } catch { invalidRecords++; }
      }
      const completed = !failure && exitCode === 0 && gateway.errorCount === 0 && invalidRecords === 0 && gateway.successful === words.length;
      const summary = this.redactor.json({ completed, exitCode, attempted: gateway.attempts, responses: gateway.successful, words: words.length,
        matched: matches.length, queued, errors: gateway.errors, errorCount: gateway.errorCount, invalidRecords,
        diagnostics: failure ?? stderr.slice(0, 4096), matches });
      const evidence = await this.evidence.put(summary, 'ffuf');
      await this.trajectory.append(session, 'fuzz/result', this.redactor.json({ evidence, completed, matched: matches.length, responses: gateway.successful, errorCount: gateway.errorCount }));
      return this.redactor.json({ ...summary as Record<string, Json>, matches: matches.slice(0, input.maxResults), evidence,
        limitation: 'URL path/query fuzzing on a fixed host. Each request is scoped, judged and budgeted by the HTTP broker. Redirects are not followed. Matching uses redacted response bodies. A match is an observation, not a verified vulnerability. Full matches are retained in local evidence.' });
    } finally { await gateway.close(); }
  }
}
