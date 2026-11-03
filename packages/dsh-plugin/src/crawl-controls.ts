/** Owner crawl controls share the same frontier and broker as pentest_crawl. */
import { PentestError, digest } from '@dsh-pentest/contracts';
import type { SessionId } from '@dsh-pentest/contracts';
import type { CrawlReport, CrawlService } from '@dsh-pentest/crawl';
import type { PentestRuntime } from './runtime.ts';

export class CrawlControls {
  private controller?: AbortController;
  private pending?: Promise<void>;
  private report?: CrawlReport;
  private error?: string;
  constructor(private readonly runtime: PentestRuntime) {}
  snapshot() {
    const frontier = this.runtime.frontier, snapshot = frontier.snapshot();
    return { config: frontier.config, running: Boolean(this.pending), queued: snapshot.queued.length,
      visited: snapshot.visited, discovered: snapshot.discovered, maxDepth: this.runtime.config.engagement.budget.maxDepth,
      candidates: snapshot.queued.slice(0,100), rejected: frontier.rejected.slice(-100), report: this.report ?? null, error: this.error ?? null };
  }
  seeds(urls: string[]): { added: number } {
    return { added: this.runtime.crawl('djupleita-settings' as SessionId).observe(urls, 'seed') };
  }
  start(session: SessionId): void {
    if (this.pending) throw new PentestError('CRAWL_RUNNING', 'A crawl is already running');
    if (!this.runtime.frontier.snapshot().queued.length) throw new PentestError('CRAWL_EMPTY', 'Add seed URLs before starting a crawl');
    this.runtime.engagement.assertAvailable(); this.runtime.engagement.attach(session);
    void this.run(this.runtime.crawl(session), session, new AbortController().signal).catch(() => {});
  }
  run(crawler: CrawlService, session: SessionId, signal: AbortSignal): Promise<CrawlReport> {
    if (this.pending) return Promise.reject(new PentestError('CRAWL_RUNNING', 'A crawl is already running'));
    const controller = new AbortController(); this.controller = controller;
    delete this.error; delete this.report;
    const operation = () => crawler.run(session, this.runtime.signal(AbortSignal.any([signal,controller.signal])));
    const origin = this.runtime.review.current();
    const work = origin ? operation() : this.runtime.review.run({ sessionId: session, tool: 'pentest_crawl',
      arguments: { source: 'owner-crawl-panel' }, argumentsHash: digest({ source: 'owner-crawl-panel' }), grants: new Set() }, operation);
    const result = work.then(report => {
      this.report = report; return report;
    }, error => { this.error = this.runtime.redactor.text(error instanceof Error ? error.message : 'Crawl failed'); throw error; });
    this.pending = result.then(() => {}, () => {}).finally(() => { delete this.pending; delete this.controller; });
    return result;
  }
  async stop(): Promise<void> { this.controller?.abort(); await this.pending; }
}
