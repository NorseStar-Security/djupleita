/** Shared, identity-aware crawl frontier consumed by HTTP, browser and recon adapters. */
import { parse } from 'parse5';
import { z } from 'zod';
import { digest, PentestError } from '@dsh-pentest/contracts';
import type { Evidence, IdentityId, SessionId } from '@dsh-pentest/contracts';
import type { ScopeService } from '@dsh-pentest/scope';
import type { HttpBroker, HttpResult } from '@dsh-pentest/http';
import { classifyHttp } from '@dsh-pentest/http';
import { graphId } from '@dsh-pentest/graph';
import type { AttackGraph } from '@dsh-pentest/graph';

export const CrawlConfigSchema = z.object({
  maxPages: z.number().int().min(1).max(10000), maxDepth: z.number().int().min(0).max(50),
  maxQueued: z.number().int().min(1).max(100000), maxPerTemplate: z.number().int().min(1).max(100),
  stalePageLimit: z.number().int().min(1).max(1000),
});
export type CrawlConfig = z.infer<typeof CrawlConfigSchema>;
export interface Candidate {
  url: string; identityId?: IdentityId; depth: number; source: 'seed' | 'http' | 'browser' | 'recon' | 'rea' | 'passive-intelligence' | 'fuzz';
  parent?: string; evidenceId?: string; score: number;
}
export interface CrawlReport {
  visited: number; discovered: number; rejected: { url: string; reason: string }[];
  remaining: number; stop: 'complete' | 'page-budget' | 'no-new-surface' | 'cancelled' | 'engagement-budget';
  errors: { url: string; message: string }[];
}

/** Normalize fragments/query ordering while preserving semantically different query values. */
export function canonicalUrl(input: string, base?: string): string {
  const url = new URL(input, base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PentestError('CRAWL_URL', 'Crawl candidates require HTTP(S) URLs without embedded credentials');
  }
  url.hash = '';
  url.searchParams.sort();
  return url.href;
}

export function endpointTemplate(input: string): string {
  const url = new URL(input);
  const path = url.pathname.replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ':id').replace(/\/\d+(?=\/|$)/g, '/:id');
  return `${url.origin}${path}?${[...new Set(url.searchParams.keys())].sort().join('&')}`;
}

type HtmlNode = { nodeName: string; attrs?: { name: string; value: string }[]; childNodes?: HtmlNode[] };
export function linksFromHtml(body: string, base: string): string[] {
  const links = new Set<string>();
  const root = parse(body) as unknown as HtmlNode;
  const visit = (node: HtmlNode) => {
    const attrs = Object.fromEntries((node.attrs ?? []).map(item => [item.name, item.value]));
    // Form actions are discovery hints only. Crawling never submits a form.
    for (const key of ['href', 'src', 'action']) {
      if (!attrs[key]) continue;
      try { links.add(canonicalUrl(attrs[key], base)); } catch { /* Non-network links are not candidates. */ }
    }
    for (const child of node.childNodes ?? []) visit(child);
  };
  visit(root);
  return [...links];
}

export class CrawlFrontier {
  private readonly queued = new Map<string, Candidate>();
  private readonly visited = new Set<string>();
  private readonly templates = new Map<string, number>();
  readonly rejected: { url: string; reason: string }[] = [];
  private discoveries = 0;
  readonly config: Readonly<CrawlConfig>;
  constructor(config: CrawlConfig, private readonly scope: ScopeService,
    private readonly ranking = { auth: 4, object: 3, query: 2, novelty: 1 }) {
    this.config = Object.freeze(CrawlConfigSchema.parse(config));
  }
  private key(candidate: Pick<Candidate, 'url' | 'identityId'>): string { return `${candidate.identityId ?? 'anonymous'}|${candidate.url}`; }
  offer(raw: Omit<Candidate, 'score'> & { score?: number }): boolean {
    let url: string;
    try {
      url = canonicalUrl(raw.url);
      this.scope.check({ url, purpose: 'target' });
      if (raw.depth > this.config.maxDepth) throw new PentestError('CRAWL_DEPTH', 'Crawl depth limit');
      if (classifyHttp({ url, method: 'GET', headers: {} }).effects.includes('delete')) {
        throw new PentestError('CRAWL_DELETION', 'Deletion endpoint recorded for review and excluded from automatic crawling');
      }
    } catch (error) {
      this.rejected.push({ url: raw.url, reason: error instanceof Error ? error.message : 'Invalid candidate' });
      return false;
    }
    const candidate = { ...raw, url, score: raw.score ?? this.score(url) };
    const key = this.key(candidate);
    if (this.visited.has(key) || this.queued.has(key)) return false;
    if (this.queued.size >= this.config.maxQueued) { this.rejected.push({ url, reason: 'Frontier capacity reached' }); return false; }
    this.queued.set(key, candidate); this.discoveries++;
    return true;
  }
  next(): Candidate | undefined {
    const ordered = [...this.queued.entries()].sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
    for (const [key, candidate] of ordered) {
      this.queued.delete(key);
      const template = `${candidate.identityId ?? 'anonymous'}|${endpointTemplate(candidate.url)}`;
      const count = this.templates.get(template) ?? 0;
      if (count >= this.config.maxPerTemplate) { this.rejected.push({ url: candidate.url, reason: 'Endpoint template sample limit' }); continue; }
      this.templates.set(template, count + 1); this.visited.add(key);
      return structuredClone(candidate);
    }
    return undefined;
  }
  snapshot(): { queued: Candidate[]; visited: number; discovered: number } {
    return { queued: structuredClone([...this.queued.values()]), visited: this.visited.size, discovered: this.discoveries };
  }
  private score(input: string): number {
    const url = new URL(input);
    return 1 + (/auth|login|account|admin|api|graphql|user|object|document/i.test(url.pathname) ? this.ranking.auth : 0)
      + (url.search ? this.ranking.query : 0) + (/\/\d+(?:\/|$)/.test(url.pathname) ? this.ranking.object : 0)
      + (this.templates.has(`anonymous|${endpointTemplate(input)}`) ? 0 : this.ranking.novelty);
  }
}

export class CrawlService {
  constructor(readonly frontier: CrawlFrontier, private readonly http: HttpBroker, private readonly graph: AttackGraph) {}

  /** Browser, REA and recon observations all enter this same scope-checked frontier. */
  observe(urls: string[], source: Candidate['source'], parent?: Candidate, evidenceId?: string): number {
    let count = 0;
    for (const url of urls) if (this.frontier.offer({ url, source, depth: parent ? parent.depth + 1 : 0,
      ...(parent?.identityId ? { identityId: parent.identityId } : {}), ...(parent ? { parent: parent.url } : {}),
      ...(evidenceId ? { evidenceId } : {}) })) count++;
    return count;
  }

  record(result: HttpResult, candidate: Candidate): string {
    const now = result.evidence.observedAt;
    this.graph.addEvidence(result.evidence);
    const url = new URL(candidate.url);
    const hostId = graphId(this.graph.engagementId, 'host', url.hostname);
    const endpointId = graphId(this.graph.engagementId, 'endpoint', endpointTemplate(candidate.url));
    this.graph.putNode({ id: hostId, type: 'Host', name: url.hostname, attributes: { hostname: url.hostname },
      evidenceIds: [result.evidence.id], observedAt: now });
    this.graph.putNode({ id: endpointId, type: 'Endpoint', name: endpointTemplate(candidate.url),
      attributes: { url: candidate.url, status: result.status, identityId: candidate.identityId ?? 'anonymous', template: endpointTemplate(candidate.url) },
      evidenceIds: [result.evidence.id], observedAt: now });
    this.graph.putEdge({ id: digest({ hostId, endpointId, type: 'Exposes' }), source: hostId, target: endpointId,
      type: 'Exposes', status: 'observed', evidenceIds: [result.evidence.id], attributes: { walkable: false }, observedAt: now });
    return endpointId;
  }

  async run(sessionId: SessionId, signal: AbortSignal): Promise<CrawlReport> {
    const report: CrawlReport = { visited: 0, discovered: 0, rejected: [], remaining: 0, stop: 'complete', errors: [] };
    let stale = 0;
    while (report.visited < this.frontier.config.maxPages) {
      if (signal.aborted) { report.stop = 'cancelled'; break; }
      const candidate = this.frontier.next();
      if (!candidate) break;
      try {
        const response = await this.http.request({ url: candidate.url, method: 'GET', headers: {},
          ...(candidate.identityId ? { identityId: candidate.identityId } : {}) }, sessionId, signal, undefined, 'active');
        this.record(response, candidate);
        report.visited++;
        const urls = /html|xhtml/i.test(response.headers['content-type'] ?? '') ? linksFromHtml(response.body, response.url) : [];
        const added = this.observe(urls, 'http', candidate, response.evidence.id);
        report.discovered += added;
        stale = added ? 0 : stale + 1;
        if (stale >= this.frontier.config.stalePageLimit) { report.stop = 'no-new-surface'; break; }
      } catch (error) {
        if (signal.aborted) { report.stop = 'cancelled'; break; }
        if (error instanceof PentestError && ['TIME_BUDGET', 'REQUEST_BUDGET'].includes(error.code)) { report.stop = 'engagement-budget'; break; }
        report.errors.push({ url: candidate.url, message: error instanceof Error ? error.message : 'Crawl failed' });
      }
    }
    if (report.visited >= this.frontier.config.maxPages) report.stop = 'page-budget';
    report.remaining = this.frontier.snapshot().queued.length;
    report.rejected = [...this.frontier.rejected];
    return report;
  }
}
