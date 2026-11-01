/** Engagement lifecycle and shared request/time budgets. */
import { EngagementSchema, PentestError, freeze } from '@dsh-pentest/contracts';
import type { Engagement, SessionId } from '@dsh-pentest/contracts';
import { setTimeout } from 'node:timers/promises';

export class EngagementService {
  readonly engagement: Readonly<Engagement>;
  readonly startedAt: number;
  private requests = 0;
  private active = 0;
  private nextRequestAt = 0;
  private readonly sessions = new Set<SessionId>();

  constructor(engagement: Engagement, private readonly now = Date.now) {
    EngagementSchema.parse(engagement);
    this.engagement = freeze(structuredClone(engagement));
    this.startedAt = now();
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
    if (this.now() - this.startedAt >= budget.durationMs) throw new PentestError('TIME_BUDGET', 'Engagement time budget exhausted');
    if (this.requests >= budget.requests) throw new PentestError('REQUEST_BUDGET', 'Engagement request budget exhausted');
    if (this.active >= budget.concurrency) throw new PentestError('CONCURRENCY_BUDGET', 'Engagement concurrency budget reached');
    if (this.now() < this.nextRequestAt) throw new PentestError('RATE_BUDGET', 'Engagement request rate reached');
    this.requests++;
    this.active++;
    this.nextRequestAt = this.now() + 1000 / budget.requestsPerSecond;
    let released = false;
    return { release: () => { if (!released) { released = true; this.active--; } } };
  }

  snapshot(): { requests: number; active: number; elapsedMs: number; remainingRequests: number } {
    return { requests: this.requests, active: this.active, elapsedMs: this.now() - this.startedAt,
      remainingRequests: Math.max(0, this.engagement.budget.requests - this.requests) };
  }
}
