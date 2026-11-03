/** Typed ProjectDiscovery adapters; discovery is evidence and never expands target scope. */
export { PassiveReconService, PassiveConfigSchema, PassiveInputSchema } from './passive.ts';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { PentestError, id, digest } from '@dsh-pentest/contracts';
import type { Json, SessionId } from '@dsh-pentest/contracts';
import type { ScopeService } from '@dsh-pentest/scope';
import type { EngagementService } from '@dsh-pentest/engagement';
import type { AttackGraph } from '@dsh-pentest/graph';
import { graphId } from '@dsh-pentest/graph';
import type { CrawlService } from '@dsh-pentest/crawl';
import type { EvidenceStore, TrajectoryStore, Redactor } from '@dsh-pentest/trajectory';
import { WorkerProxy, runWorker, validateExecutable } from '@dsh-pentest/worker';
import { observedUrls } from '@dsh-pentest/rea';
import { ReconToolSchema } from './tools.ts';
import type { ReconTool } from './tools.ts';
export { ReconToolSchema } from './tools.ts';
export type { ReconTool } from './tools.ts';
export { installReconTools } from './install.ts';

export const ReconConfigSchema = z.object({ binaries: z.partialRecord(ReconToolSchema, z.object({ path: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
  sources: z.array(z.string().regex(/^[a-z0-9_-]+$/)).min(1).default(['crtsh']),
  providerConfig: z.string().optional(), timeoutMs: z.number().int().min(1000).max(1800000).default(120000) });
export type ReconConfig = z.infer<typeof ReconConfigSchema>;
export const ReconInputSchema = z.object({ tool: ReconToolSchema, target: z.string().min(1).max(2048), depth: z.number().int().min(0).max(20).default(3), rate: z.number().int().positive().max(100000).optional(), concurrency: z.number().int().positive().max(1000).optional() });
export type ReconInput = z.infer<typeof ReconInputSchema>;
/** Model-facing request: batches are explicit arrays, never ambiguous URL strings. */
export const ReconRequestSchema = ReconInputSchema.extend({
  target: z.string().min(1).max(2048).optional().describe('One bare domain for passive tools, or one absolute HTTP(S) URL for httpx/katana. Use targets for an httpx batch.'),
  targets: z.array(z.string().url().max(2048)).min(1).max(1000).optional().describe('httpx only: explicit URL array, processed in one rate-limited worker. No target-list file is needed.'),
}).superRefine((input, ctx) => {
  if (Boolean(input.target) === Boolean(input.targets)) ctx.addIssue({ code: 'custom', message: 'Provide exactly one of target or targets.' });
  if (input.targets && input.tool !== 'httpx') ctx.addIssue({ code: 'custom', path: ['targets'], message: 'Only httpx accepts a targets batch.' });
});
export function reconInputs(raw: unknown): ReconInput[] {
  const { targets, ...input } = ReconRequestSchema.parse(raw);
  return [...new Set(targets ?? [input.target!])].map(target => ReconInputSchema.parse({ ...input, target }));
}

export function reconMode(tool: ReconTool): 'passive' | 'active' { return tool === 'httpx' || tool === 'katana' ? 'active' : 'passive'; }

export class ReconService {
  constructor(readonly config: ReconConfig, private readonly root: string, private readonly scope: ScopeService,
    private readonly engagement: EngagementService, private readonly graph: AttackGraph,
    private readonly evidence: EvidenceStore, private readonly trajectory: TrajectoryStore,
    private readonly redactor: Redactor, private readonly crawl: (session: SessionId) => CrawlService) { ReconConfigSchema.parse(config); }

  check(input: ReconInput): void {
    if (/[\x00-\x20\x7f]/.test(input.target)) throw new PentestError('RECON_TARGET', 'Use one exact domain or URL per target; pass an explicit targets array for an httpx batch');
    if (reconMode(input.tool) === 'active') { this.scope.check({ url: input.target, purpose: 'target' }); return; }
    const hostname = new URL(`https://${input.target}/`).hostname;
    if (hostname !== input.target.toLowerCase() || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(input.target)) throw new PentestError('RECON_TARGET', 'Passive reconnaissance requires a bare domain');
    this.scope.check({ url: `https://${hostname}/`, purpose: 'target', access: 'read' });
  }
  private async binary(tool: ReconTool): Promise<string> {
    const install = this.config.binaries[tool];
    if (!install) throw new PentestError('RECON_MISSING', `${tool} is not installed. Open Pentest → Plugins → Tool setup and select Install recon tools, or run pnpm setup:tools --only recon, then Load local setup.`);
    const path = await validateExecutable(install.path);
    const hash = createHash('sha256').update(await readFile(path)).digest('hex');
    if (hash !== install.sha256) throw new PentestError('RECON_INTEGRITY', `${tool} executable does not match its operator-pinned SHA-256`);
    return path;
  }
  async doctor(): Promise<Json> {
    const result: Record<string, Json> = {};
    for (const tool of ReconToolSchema.options) {
      try { result[tool] = { ready: true, path: await this.binary(tool), mode: reconMode(tool) }; }
      catch (error) { result[tool] = { ready: false, mode: reconMode(tool), reason: error instanceof Error ? error.message : 'Unavailable' }; }
    }
    return result;
  }
  async run(raw: ReconInput, session: SessionId, signal: AbortSignal): Promise<Json> {
    return this.execute(raw, session, signal);
  }
  async runBatch(raw: ReconInput[], session: SessionId, signal: AbortSignal): Promise<Json> {
    const inputs = z.array(ReconInputSchema).min(1).max(1000).parse(raw);
    if (inputs.some(input => input.tool !== 'httpx')) throw new PentestError('RECON_BATCH', 'Only httpx accepts a targets batch');
    const first = inputs[0]!;
    if (inputs.some(input => input.rate !== first.rate || input.concurrency !== first.concurrency)) throw new PentestError('RECON_BATCH', 'Batch targets must share rate and concurrency limits');
    return this.execute(first, session, signal, [...new Set(inputs.map(input => input.target))]);
  }
  private async execute(raw: ReconInput, session: SessionId, signal: AbortSignal, targets?: string[]): Promise<Json> {
    const input = ReconInputSchema.parse(raw);
    // Validate the complete batch before any process or network activity.
    for (const target of targets ?? [input.target]) this.check({ ...input, target });
    this.engagement.assertAvailable();
    const executable = await this.binary(input.tool), mode = reconMode(input.tool);
    const work = join(this.root, id<'ReconRunId'>()); await mkdir(work, { recursive: true, mode: 0o700 });
    const cwd = await realpath(work);
    const list = join(cwd, 'targets.txt');
    if (targets) await writeFile(list, targets.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    const subject = targets ? `httpx batch (${targets.length} targets)` : input.target;
    const proxy = new WorkerProxy(this.scope, this.engagement, this.trajectory, this.redactor, session,
      'target', signal, mode === 'passive' ? 'read' : 'active');
    await proxy.start();
    const rate = String(Math.max(1, Math.min(input.rate ?? Infinity, Math.floor(this.engagement.engagement.budget.requestsPerSecond))));
    const concurrency = String(Math.min(input.concurrency ?? Infinity, this.engagement.engagement.budget.concurrency));
    const maxBytes = String(this.engagement.engagement.budget.maxResponseBytes);
    const args: Record<ReconTool, string[]> = {
      subfinder: ['-d', input.target, '-s', this.config.sources.join(','), '-json', '-silent', '-duc', '-rl', rate, '-proxy', proxy.endpoint],
      asnmap: ['-d', input.target, '-json', '-silent', '-duc'],
      uncover: ['-q', `hostname:"${input.target}"`, '-e', 'shodan', '-json', '-silent', '-duc', '-rl', rate, '-limit', '1000'],
      httpx: [...(targets ? ['-l', list] : ['-u', input.target]), '-json', '-silent', '-duc', '-no-fallback-scheme', '-no-stdin', '-threads', concurrency,
        '-rl', rate, '-rstr', maxBytes, '-proxy', proxy.endpoint, '-title', '-status-code', '-tech-detect'],
      katana: ['-u', input.target, '-jsonl', '-silent', '-duc', '-depth', String(Math.min(input.depth, this.engagement.engagement.budget.maxDepth)),
        '-concurrency', concurrency, '-rate-limit', rate, '-max-response-size', maxBytes, '-proxy', proxy.endpoint, '-js-crawl', '-form-extraction'],
    };
    try {
      if (this.config.providerConfig && ['subfinder', 'uncover'].includes(input.tool)) {
        // JSON is a YAML subset accepted by PD tools and gives us an unambiguous
        // credential inventory for redaction before any worker output is retained.
        const content = JSON.parse(await readFile(this.config.providerConfig, 'utf8')) as unknown;
        const providers = z.record(z.string(), z.union([z.string(), z.array(z.string())])).parse(content);
        for (const value of Object.values(providers)) for (const secret of typeof value === 'string' ? [value] : value) if (secret) this.redactor.register(secret);
        const destination = join(cwd, 'provider-config.yaml'); await writeFile(destination, JSON.stringify(providers), { mode: 0o600, flag: 'wx' });
        args[input.tool].push('-pc', destination);
      }
      await this.trajectory.append(session, 'recon/start', this.redactor.json({ tool: input.tool, target: subject, ...(targets ? { targets } : {}), mode }));
      const result = await runWorker({ executable, args: args[input.tool], cwd, timeoutMs: this.config.timeoutMs,
        maxOutputBytes: 16 * 1024 * 1024, env: { HTTP_PROXY: proxy.endpoint, HTTPS_PROXY: proxy.endpoint,
          ALL_PROXY: proxy.endpoint, NO_PROXY: '', DISABLE_TELEMETRY: 'true' } },
        { writableRoots: [cwd], readableRoots: [executable], proxyPort: proxy.sandboxPort }, signal);
      // A CLI may exit zero after its upstream sources were denied by the broker.
      // Never present that failure as successful empty discovery.
      proxy.assertHealthy();
      if (result.exitCode !== 0) throw new PentestError('RECON_EXIT', `${input.tool} exited with status ${result.exitCode}: ${this.redactor.text(result.stderr).slice(0, 2000)}`);
      const records: Json[] = [];
      for (const line of result.stdout.split('\n').filter(Boolean)) {
        try { records.push(this.redactor.json(JSON.parse(line))); }
        catch { records.push(this.redactor.text(line)); }
      }
      const evidence = await this.evidence.put(this.redactor.json({ tool: input.tool, target: subject, ...(targets ? { targets } : {}), mode, records,
        exitCode: result.exitCode, diagnostics: result.stderr }), `projectdiscovery/${input.tool}`);
      this.graph.addEvidence(evidence);
      const rootId = graphId(this.graph.engagementId, 'recon', targets ? digest(targets) : input.target);
      this.graph.putNode({ id: rootId, type: 'ReconTarget', name: subject, attributes: { mode, tool: input.tool, targetCount: targets?.length ?? 1 }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
      const urls = new Set(observedUrls(records));
      const hosts = new Set<string>();
      for (const record of records) {
        if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
        for (const key of ['host', 'input', 'hostname', 'domain']) {
          const value = record[key];
          if (typeof value === 'string' && /^[a-z0-9][a-z0-9.-]+$/i.test(value)) hosts.add(value.toLowerCase());
        }
      }
      for (const hostname of hosts) {
        const hostId = graphId(this.graph.engagementId, 'host', hostname);
        this.graph.putNode({ id: hostId, type: 'Host', name: hostname, attributes: { hostname, discoveryOnly: true }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
        this.graph.putEdge({ id: digest({ rootId, hostId }), source: rootId, target: hostId, type: 'Discovered', status: 'observed',
          attributes: { walkable: false }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
        urls.add(`https://${hostname}/`);
      }
      const queued = this.crawl(session).observe([...urls], 'recon', undefined, evidence.id);
      await this.trajectory.append(session, 'recon/result', this.redactor.json({ tool: input.tool, evidence, mode, hosts: hosts.size,
        discovered: urls.size, queued, exitCode: result.exitCode }));
      return this.redactor.json({ tool: input.tool, mode, recordCount: records.length, targetCount: targets?.length ?? 1, records, evidence, queued, exitCode: result.exitCode,
        limitation: 'TLS tunnel budgets count connections; CLI request rate is independently bounded. Discovered assets do not grant target scope.' });
    } finally { await proxy.close(); }
  }
}
