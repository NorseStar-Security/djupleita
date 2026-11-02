/** Owner decisions for paused operations, with engagement-local, revocable exact grants. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { digest, id, PentestError } from '@dsh-pentest/contracts';
import type { Json, SessionId, TrajectorySink } from '@dsh-pentest/contracts';
import { normalizeHostname } from '@dsh-pentest/scope';
import { withJudgmentBudget } from '@dsh-pentest/policy';

/** Destination allowances accept one literal DNS name or IP, never a URL or wildcard. */
export function allowanceHost(value: string): string {
  const host = value.trim();
  if (!host || /[\s/@?#*\\]/.test(host)) throw new PentestError('INVALID_HOST', 'Enter one exact hostname or IP address, without a URL, port, path or wildcard');
  return normalizeHostname(host);
}
function reviewHost(category: string, details: Json): string | undefined {
  if (!['scope', 'network'].includes(category) || !details || typeof details !== 'object' || Array.isArray(details)) return;
  const destination = category === 'network' ? details.destination : details;
  if (!destination || typeof destination !== 'object' || Array.isArray(destination) || typeof destination.url !== 'string') return;
  const url = new URL(destination.url);
  if (!['http:', 'https:', 'tcp:', 'tls:'].includes(url.protocol) || url.username || url.password) return;
  return allowanceHost(url.hostname);
}

export interface ReviewOrigin {
  sessionId: SessionId; tool: string; callId?: string; argumentsHash: string; arguments: Json;
  grants: Set<string>;
}
export interface ReviewQuestion {
  id: string; sessionId: SessionId; tool: string; callId?: string; category: string;
  reason: string; details: Json; operation: Json; host?: string;
}
const GrantSchema = z.object({ id: z.string().uuid(), key: z.string(), tool: z.string(), category: z.string(),
  reason: z.string(), details: z.json(), operation: z.json(), createdAt: z.string(),
  kind: z.enum(['operation', 'destination']).optional(), host: z.string().optional() }).superRefine((grant, ctx) => {
    if (grant.kind !== 'destination') return;
    try {
      if (!grant.host || allowanceHost(grant.host) !== grant.host || grant.key !== digest({ destinationHost: grant.host }) || grant.tool !== '*' || grant.category !== 'destination') throw new Error();
    } catch { ctx.addIssue({ code: 'custom', message: 'Invalid saved destination allowance' }); }
  });
export type ReviewGrant = z.infer<typeof GrantSchema>;
interface Pending { question: ReviewQuestion; key: string; origin: ReviewOrigin; signal: AbortSignal; settle(answer: boolean): void }
export type ReviewChoice = 'once' | 'always' | 'destination' | 'reject';

export class ReviewService {
  private readonly context = new AsyncLocalStorage<ReviewOrigin>();
  private readonly judgment = new AsyncLocalStorage<() => () => void>();
  private readonly pending = new Map<string, Pending>();
  private grants: ReviewGrant[] = [];
  private queue = Promise.resolve();
  private owners = 0;
  constructor(private readonly root: string, private readonly revision: () => string, private readonly sink: TrajectorySink, private readonly display: (value: Json) => Json = value => value) {}
  async load(): Promise<void> {
    try { this.grants = z.array(GrantSchema).parse(JSON.parse(await readFile(join(this.root, 'grants.json'), 'utf8'))); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  }
  connect(): () => void { let connected = true; this.owners++; return () => { if (connected) { connected = false; if (--this.owners === 0) this.cancel(); } }; }
  run<T>(origin: ReviewOrigin, operation: () => T): T { return this.context.run(origin, operation); }
  current(): ReviewOrigin | undefined { return this.context.getStore(); }
  judgmentBudget<T>(milliseconds: number, signal: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return withJudgmentBudget(milliseconds, signal, (budgetSignal, pause) => this.judgment.run(pause, () => operation(budgetSignal)));
  }
  private key(category: string, details: Json, origin: ReviewOrigin): string {
    return digest({ revision: this.revision(), tool: origin.tool, argumentsHash: origin.argumentsHash, category, details });
  }
  allows(category: string, details: Json): boolean {
    const origin = this.current();
    if (!origin) return false;
    const host = reviewHost(category, details);
    if (host && this.grants.some(grant => grant.kind === 'destination' && grant.host === host)) return true;
    const key = this.key(category, details, origin);
    return origin.grants.has(key) || this.grants.some(grant => grant.key === key);
  }
  async request(category: string, details: Json, reason: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const origin = this.current();
    if (!origin) return false;
    const key = this.key(category, details, origin);
    if (this.allows(category, details)) {
      const host = reviewHost(category, details), destinationGrant = host && this.grants.find(grant => grant.kind === 'destination' && grant.host === host);
      await this.sink.append(origin.sessionId, 'policy/grant-used', { key: destinationGrant ? destinationGrant.key : key,
        category, tool: origin.tool, callId: origin.callId ?? null, ...(destinationGrant ? { grantId: destinationGrant.id, host: destinationGrant.host! } : {}) });
      return true;
    }
    if (!this.owners) return false;
    const question: ReviewQuestion = { id: id<'ReviewId'>(), sessionId: origin.sessionId, tool: origin.tool,
      ...(origin.callId ? { callId: origin.callId } : {}), category, reason: String(this.display(reason)), details: this.display(details), operation: this.display(origin.arguments),
      ...(reviewHost(category, details) ? { host: reviewHost(category, details)! } : {}) };
    await this.sink.append(origin.sessionId, 'policy/review-requested', { ...question });
    signal.throwIfAborted();
    const resume = this.judgment.getStore()?.();
    try { return await new Promise<boolean>(resolve => {
      const abort = () => settle(false);
      const settle = (answer: boolean) => {
        signal.removeEventListener('abort', abort); this.pending.delete(question.id);
        resolve(answer && !signal.aborted);
      };
      this.pending.set(question.id, { question, key, origin, signal, settle });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }); } finally { resume?.(); }
  }
  snapshot(sessionId?: SessionId): { pending: ReviewQuestion[]; grants: ReviewGrant[] } {
    return { pending: [...this.pending.values()].map(value => value.question).filter(value => !sessionId || value.sessionId === sessionId),
      grants: this.grants.map(grant => ({ ...grant })) };
  }
  /** Only the authenticated owner channel exposes this operation. */
  async decide(requestId: string, sessionId: SessionId, choice: ReviewChoice): Promise<void> {
    const next = this.queue.then(async () => {
      const pending = this.pending.get(requestId);
      if (!pending || pending.question.sessionId !== sessionId || pending.signal.aborted) {
        throw new PentestError('REVIEW_EXPIRED', 'This review is no longer pending in this chat');
      }
      const { question, key, origin } = pending;
      if (choice === 'destination' && !question.host) throw new PentestError('DESTINATION_MISSING', 'This review has no verified destination; approve its independent restriction separately');
      const save = choice === 'always' || choice === 'destination';
      const savedKey = choice === 'destination' ? digest({ destinationHost: question.host }) : key;
      const grants = save ? [...this.grants.filter(grant => grant.key !== savedKey), {
        id: id<'GrantId'>(), key: savedKey, tool: choice === 'destination' ? '*' : question.tool,
        category: choice === 'destination' ? 'destination' : question.category,
        reason: choice === 'destination' ? `All network calls to ${question.host}; independent effect and filesystem restrictions still apply` : question.reason,
        details: question.details, operation: question.operation, createdAt: new Date().toISOString(),
        ...(choice === 'destination' ? { kind: 'destination' as const, host: question.host! } : { kind: 'operation' as const }),
      }] : this.grants;
      if (save) await this.persist(grants);
      if (pending.signal.aborted || this.pending.get(requestId) !== pending) {
        if (save) await this.persist(this.grants);
        throw new PentestError('REVIEW_EXPIRED', 'The operation was cancelled before approval completed');
      }
      try {
        await this.sink.append(sessionId, 'policy/review-decided', { requestId, choice, key, tool: question.tool,
          callId: question.callId ?? null, source: 'desktop-owner',
          ...(choice === 'destination' ? { host: question.host!, grantKey: savedKey, grantId: grants.find(grant => grant.key === savedKey)!.id } : {}) });
        pending.signal.throwIfAborted();
      } catch (error) { if (save) await this.persist(this.grants); throw error; }
      if (save) this.grants = grants;
      if (choice === 'once' || choice === 'always') origin.grants.add(key);
      pending.settle(choice !== 'reject');
      // One destination decision releases other chats paused at the same network boundary.
      if (choice === 'destination') await this.releaseDestination(question.host!, grants.find(grant => grant.key === savedKey)!);
    });
    this.queue = next.catch(() => {}); return next;
  }
  async addDestination(host: string, sessionId: SessionId): Promise<void> {
    const normalized = allowanceHost(host), key = digest({ destinationHost: normalized });
    const next = this.queue.then(async () => {
      const grant: ReviewGrant = { id: id<'GrantId'>(), key, kind: 'destination', host: normalized, tool: '*', category: 'destination',
        reason: `All network calls to ${normalized}; independent effect and filesystem restrictions still apply`, details: { host: normalized }, operation: {}, createdAt: new Date().toISOString() };
      const grants = [...this.grants.filter(item => item.key !== key), grant];
      await this.persist(grants);
      try { await this.sink.append(sessionId, 'policy/destination-granted', { host: normalized, grantId: grant.id, source: 'desktop-owner' }); }
      catch (error) { await this.persist(this.grants); throw error; }
      this.grants = grants;
      await this.releaseDestination(normalized, grant);
    }); this.queue = next.catch(() => {}); return next;
  }
  async revoke(grantId: string, sessionId: SessionId): Promise<void> {
    const next = this.queue.then(async () => {
      const grants = this.grants.filter(grant => grant.id !== grantId);
      if (grants.length === this.grants.length) throw new PentestError('GRANT_MISSING', 'This saved allowance no longer exists');
      await this.persist(grants);
      try { await this.sink.append(sessionId, 'policy/grant-revoked', { grantId, source: 'desktop-owner' }); }
      catch (error) { await this.persist(this.grants); throw error; }
      this.grants = grants;
    }); this.queue = next.catch(() => {}); return next;
  }
  private async persist(grants: ReviewGrant[]): Promise<void> {
    const path = join(this.root, 'grants.json'), temporary = `${path}.${id<'WriteId'>()}.tmp`;
    await writeFile(temporary, JSON.stringify(grants), { mode: 0o600 }); await rename(temporary, path);
  }
  private async releaseDestination(host: string, grant: ReviewGrant): Promise<void> {
    for (const waiting of this.pending.values()) if (waiting.question.host === host) {
      await this.sink.append(waiting.origin.sessionId, 'policy/grant-used', { key: grant.key, grantId: grant.id,
        category: waiting.question.category, tool: waiting.question.tool, callId: waiting.question.callId ?? null, host });
      waiting.settle(true);
    }
  }
  cancel(): void { for (const pending of this.pending.values()) pending.settle(false); }
  async close(): Promise<void> { this.cancel(); await this.queue; this.context.disable(); this.judgment.disable(); }
}
