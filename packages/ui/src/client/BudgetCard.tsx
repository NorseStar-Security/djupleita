import css from './Panel.module.css';
export interface BudgetSnapshot {
  requests: number; remainingRequests: number; requestLimit: number; durationMs: number;
  startedAt: number; expiresAt: number; remainingMs: number; timeExhausted: boolean;
  requestsPerSecond: number; concurrency: number;
}
export function BudgetCard({ budget, busy, renew }: { budget: BudgetSnapshot; busy: boolean; renew(): void }) {
  return <section className={css.card} aria-label="Engagement budget">
    <h3>Engagement budget</h3>
    <p role={budget.timeExhausted ? 'alert' : 'status'}>{budget.timeExhausted ? 'Time budget expired. Network tools cannot run until you renew it.' : `Time remaining: ${Math.ceil(budget.remainingMs / 60000)} minutes.`}</p>
    <p>{budget.requests} / {budget.requestLimit} requests used · {budget.requestsPerSecond} requests/second · {budget.concurrency} concurrent.</p>
    <p>Time allowance: {budget.durationMs / 60000} minutes. Expires: {new Date(budget.expiresAt).toLocaleString()}. The clock includes idle time and persists across app restarts.</p>
    <button type="button" className={css.button} disabled={busy} onClick={renew}>Renew time budget</button>
    <p>Renewal starts a fresh time allowance and keeps request usage, scope, credentials and evidence.</p>
  </section>;
}
