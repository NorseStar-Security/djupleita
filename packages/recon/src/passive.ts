/** Passive DNS and ProjectDiscovery intelligence; never probes the target. */
import { z } from 'zod';
import { digest, PentestError } from '@dsh-pentest/contracts';
import type { IdentityId, Json, SessionId } from '@dsh-pentest/contracts';
import type { ScopeService } from '@dsh-pentest/scope';
import type { EngagementService } from '@dsh-pentest/engagement';
import type { EvidenceStore, TrajectoryStore, Redactor } from '@dsh-pentest/trajectory';
import { graphId } from '@dsh-pentest/graph';
import type { AttackGraph } from '@dsh-pentest/graph';
import type { CrawlService } from '@dsh-pentest/crawl';

export const PassiveConfigSchema = z.object({ dohEndpoint: z.url().default('https://dns.google/resolve'),
  pdcpIdentityId: z.string().uuid().optional(), chaosIdentityId: z.string().uuid().optional() });
export type PassiveConfig = z.infer<typeof PassiveConfigSchema>;
export const PassiveInputSchema = z.object({ operation: z.enum(['dns', 'associated-domains', 'breach-exposure', 'chaos']),
  domain: z.string().min(1).max(253), page: z.number().int().min(1).max(1000).default(1) });
export type PassiveInput = z.infer<typeof PassiveInputSchema>;
export type PassiveSender = (url: string, signal: AbortSignal, identityId?: IdentityId) => Promise<Json>;

export class PassiveReconService {
  constructor(private readonly config: PassiveConfig, private readonly scope: ScopeService, private readonly engagement: EngagementService,
    private readonly send: PassiveSender, private readonly graph: AttackGraph, private readonly evidence: EvidenceStore,
    private readonly trajectories: TrajectoryStore, private readonly redactor: Redactor, private readonly crawl: (session: SessionId) => CrawlService) {}
  check(domain: string): void {
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(domain)) throw new PentestError('RECON_DOMAIN', 'Use a bare domain');
    const name = new URL(`https://${domain}`).hostname;
    this.scope.check({ url: `https://${name}/`, purpose: 'target', access: 'read' });
  }
  async run(raw: PassiveInput, session: SessionId, signal: AbortSignal): Promise<Json> {
    const input = PassiveInputSchema.parse(raw); this.check(input.domain);
    const requests: { url: string; identity?: IdentityId }[] = [];
    if (input.operation === 'dns') for (const type of ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'CAA']) {
      const url = new URL(this.config.dohEndpoint); url.searchParams.set('name', input.domain); url.searchParams.set('type', type);
      requests.push({ url: url.href });
    }
    if (input.operation === 'associated-domains') {
      if (!this.config.pdcpIdentityId) throw new PentestError('PDCP_KEY', 'Configure a host-bound PDCP API-key identity');
      requests.push({ url: `https://api.projectdiscovery.io/v1/domain/associated?domain=${encodeURIComponent(input.domain)}&limit=100&page=${input.page}`, identity: this.config.pdcpIdentityId as IdentityId });
    }
    if (input.operation === 'breach-exposure') requests.push({ url: `https://api.projectdiscovery.io/v1/leaks/stats/domain?domain=${encodeURIComponent(input.domain)}&unmask_email=false`,
      ...(this.config.pdcpIdentityId ? { identity: this.config.pdcpIdentityId as IdentityId } : {}) });
    if (input.operation === 'chaos') {
      if (!this.config.chaosIdentityId) throw new PentestError('PDCP_KEY', 'Configure a host-bound Chaos authorization-header identity');
      requests.push({ url: `https://dns.projectdiscovery.io/dns/${encodeURIComponent(input.domain)}`, identity: this.config.chaosIdentityId as IdentityId });
    }
    const records: Json[] = [];
    for (const request of requests) {
      const reservation = await this.engagement.acquire(signal);
      try {
        await this.trajectories.append(session, 'intelligence/start', { operation: input.operation, domain: input.domain, url: request.url });
        records.push(await this.send(request.url, signal, request.identity));
      } finally { reservation.release(); }
    }
    // Public exposure statistics can include samples. Keep passwords redacted
    // and strip sample rows; this plugin inventories exposure, not credentials.
    const clean = this.redactor.json(records.map(record => {
      if (input.operation !== 'breach-exposure' || !record || Array.isArray(record) || typeof record !== 'object') return record;
      return Object.fromEntries(Object.entries(record).filter(([key]) => !/sample|password/i.test(key)));
    }));
    const evidence = await this.evidence.put(clean, `intelligence/${input.operation}`); this.graph.addEvidence(evidence);
    const source = graphId(this.graph.engagementId, 'domain', input.domain);
    this.graph.putNode({ id: source, type: 'Domain', name: input.domain, attributes: { discoveryOnly: true }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    const observation = graphId(this.graph.engagementId, 'intelligence', evidence.contentHash);
    this.graph.putNode({ id: observation, type: 'IntelligenceObservation', name: input.operation, attributes: { records: clean }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    this.graph.putEdge({ id: digest({ source, observation }), source, target: observation, type: 'Observed', status: 'observed', attributes: { walkable: false }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    const domains = new Set<string>();
    for (const record of records) if (record && typeof record === 'object' && !Array.isArray(record)) {
      for (const row of Array.isArray(record.results) ? record.results : []) if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.domain === 'string') domains.add(row.domain);
      for (const name of Array.isArray(record.subdomains) ? record.subdomains : []) if (typeof name === 'string') domains.add(name.includes('.') ? name : `${name}.${input.domain}`);
    }
    for (const domain of domains) {
      const target = graphId(this.graph.engagementId, 'domain', domain);
      this.graph.putNode({ id: target, type: 'Domain', name: domain, attributes: { discoveryOnly: true }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
      this.graph.putEdge({ id: digest({ source, target }), source, target, type: 'AssociatedWith', status: 'inferred', attributes: { walkable: false }, evidenceIds: [evidence.id], observedAt: evidence.observedAt });
    }
    const queued = this.crawl(session).observe([...domains].map(domain => `https://${domain}/`), 'passive-intelligence', undefined, evidence.id);
    await this.trajectories.append(session, 'intelligence/result', this.redactor.json({ operation: input.operation, domain: input.domain, evidence, queued }));
    return { operation: input.operation, records: clean, evidence: { ...evidence }, queued };
  }
}
