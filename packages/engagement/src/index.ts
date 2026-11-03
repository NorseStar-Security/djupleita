/** Engagement lifecycle and shared request/time budgets. */
import { EngagementSchema, PentestError, freeze } from '@dsh-pentest/contracts';
import type { Engagement, SessionId } from '@dsh-pentest/contracts';
import { setTimeout } from 'node:timers/promises';

export class EngagementService {
  readonly engagement: Readonly<Engagement>;
  private start: number;
  get startedAt(): number { return this.start; }
  private requests = 0;
  private active = 0;
  private nextRequestAt = 0;
  private readonly sessions = new Set<SessionId>();

  constructor(engagement: Engagement, private readonly now = Date.now,
    private readonly checkpoint?: { initial?: { requests: number; startedAt: number }; save(value: { requests: number; startedAt: number }): void }) {
    EngagementSchema.parse(engagement);
    this.engagement = freeze(structuredClone(engagement));
    this.start = checkpoint?.initial?.startedAt ?? now();
    this.requests = checkpoint?.initial?.requests ?? 0;
    checkpoint?.save({ requests: this.requests, startedAt: this.startedAt });
  }

  attach(sessionId: SessionId): void { this.sessions.add(sessionId); }
  hasSession(sessionId: SessionId): boolean { return this.sessions.has(sessionId); }

  /** Wait for a rate/concurrency slot while retaining the caller's cancellation. */
  async acquire(signal: AbortSignal): Promise<{ release(): void }> {
    for (;;) {
      signal.throwIfAborted();
      try { return this.reserve(); }
      catch (error) {
        if (!(error instanceof PentestError) || !['RATE_BUDGET', 'CONCURRENCY_BUDGET'].includes(error.code)) throw error;
        await setTimeout(Math.max(1, Math.min(50, this.nextRequestAt - this.now())), undefined, { signal });
      }
    }
  }

  /** Reserve one attempt; failed requests still consume a request budget. */
  reserve(): { release(): void } {
    const budget = this.engagement.budget;
    this.assertAvailable();
    if (this.active >= budget.concurrency) throw new PentestError('CONCURRENCY_BUDGET', 'Engagement concurrency budget reached');
    if (this.now() < this.nextRequestAt) throw new PentestError('RATE_BUDGET', 'Engagement request rate reached');
    this.checkpoint?.save({ requests: this.requests + 1, startedAt: this.startedAt });
    this.requests++;
    this.active++;
    this.nextRequestAt = this.now() + 1000 / budget.requestsPerSecond;
    let released = false;
    return { release: () => { if (!released) { released = true; this.active--; } } };
  }

  /** Preflight without spending a request or prompting for an impossible operation. */
  assertAvailable(): void {
    if (this.now() - this.startedAt >= this.engagement.budget.durationMs) throw new PentestError('TIME_BUDGET', 'Engagement time budget exhausted. Open Engagement and identities → Policy → Renew time budget. Approval and app restart do not renew it.');
    if (this.requests >= this.engagement.budget.requests) throw new PentestError('REQUEST_BUDGET', 'Engagement request budget exhausted');
  }
  /** Owner-only caller renews time; request accounting is never reset. Persist before mutation. */
  renewTime(): void {
    const startedAt = this.now();
    this.checkpoint?.save({ requests: this.requests, startedAt });
    this.start = startedAt;
  }
  snapshot() {
    const elapsedMs = Math.max(0, this.now() - this.startedAt), durationMs = this.engagement.budget.durationMs;
    return { requests: this.requests, active: this.active, elapsedMs,
      startedAt: this.startedAt, expiresAt: this.startedAt + durationMs, durationMs,
      remainingMs: Math.max(0, durationMs - elapsedMs), timeExhausted: elapsedMs >= durationMs,
      requestLimit: this.engagement.budget.requests, concurrency: this.engagement.budget.concurrency,
      requestsPerSecond: this.engagement.budget.requestsPerSecond,
      remainingRequests: Math.max(0, this.engagement.budget.requests - this.requests) };
  }
}
