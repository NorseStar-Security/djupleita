/** Owner decisions for paused operations, with engagement-local, revocable exact grants. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { digest, id, PentestError } from '@dsh-pentest/contracts';
import type { Json, SessionId, TrajectorySink } from '@dsh-pentest/contracts';

export interface ReviewOrigin {
  sessionId: SessionId; tool: string; callId?: string; argumentsHash: string; arguments: Json;
  grants: Set<string>;
}
export interface ReviewQuestion {
  id: string; sessionId: SessionId; tool: string; callId?: string; category: string;
  reason: string; details: Json; operation: Json;
}
const GrantSchema = z.object({ id: z.string().uuid(), key: z.string(), tool: z.string(), category: z.string(),
  reason: z.string(), details: z.json(), operation: z.json(), createdAt: z.string() });
export type ReviewGrant = z.infer<typeof GrantSchema>;
interface Pending { question: ReviewQuestion; key: string; origin: ReviewOrigin; signal: AbortSignal; settle(answer: boolean): void }
export type ReviewChoice = 'once' | 'always' | 'reject';

export class ReviewService {
  private readonly context = new AsyncLocalStorage<ReviewOrigin>();
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
  private key(category: string, details: Json, origin: ReviewOrigin): string {
    return digest({ revision: this.revision(), tool: origin.tool, argumentsHash: origin.argumentsHash, category, details });
  }
  allows(category: string, details: Json): boolean {
    const origin = this.current();
    if (!origin) return false;
    const key = this.key(category, details, origin);
    return origin.grants.has(key) || this.grants.some(grant => grant.key === key);
  }
  async request(category: string, details: Json, reason: string, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const origin = this.current();
    if (!origin) return false;
    const key = this.key(category, details, origin);
    if (this.allows(category, details)) {
      await this.sink.append(origin.sessionId, 'policy/grant-used', { key, category, tool: origin.tool, callId: origin.callId ?? null });
      return true;
    }
    if (!this.owners) return false;
    const question: ReviewQuestion = { id: id<'ReviewId'>(), sessionId: origin.sessionId, tool: origin.tool,
      ...(origin.callId ? { callId: origin.callId } : {}), category, reason: String(this.display(reason)), details: this.display(details), operation: this.display(origin.arguments) };
    await this.sink.append(origin.sessionId, 'policy/review-requested', { ...question });
    signal.throwIfAborted();
    return new Promise<boolean>(resolve => {
      const abort = () => settle(false);
      const settle = (answer: boolean) => {
        signal.removeEventListener('abort', abort); this.pending.delete(question.id);
        resolve(answer && !signal.aborted);
      };
      this.pending.set(question.id, { question, key, origin, signal, settle });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
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
      const grants = choice === 'always' ? [...this.grants.filter(grant => grant.key !== key), {
        id: id<'GrantId'>(), key, tool: question.tool, category: question.category, reason: question.reason,
        details: question.details, operation: question.operation, createdAt: new Date().toISOString(),
      }] : this.grants;
      if (choice === 'always') await this.persist(grants);
      if (pending.signal.aborted || this.pending.get(requestId) !== pending) {
        if (choice === 'always') await this.persist(this.grants);
        throw new PentestError('REVIEW_EXPIRED', 'The operation was cancelled before approval completed');
      }
      try {
        await this.sink.append(sessionId, 'policy/review-decided', { requestId, choice, key, tool: question.tool,
          callId: question.callId ?? null, source: 'desktop-owner' });
        pending.signal.throwIfAborted();
      } catch (error) { if (choice === 'always') await this.persist(this.grants); throw error; }
      if (choice === 'always') this.grants = grants;
      if (choice !== 'reject') origin.grants.add(key);
      pending.settle(choice !== 'reject');
    });
    this.queue = next.catch(() => {}); return next;
  }
  async revoke(grantId: string, sessionId: SessionId): Promise<void> {
    const next = this.queue.then(async () => {
      const grants = this.grants.filter(grant => grant.id !== grantId);
      if (grants.length === this.grants.length) throw new PentestError('GRANT_MISSING', 'This saved allowance no longer exists');
      await this.persist(grants);
      await this.sink.append(sessionId, 'policy/grant-revoked', { grantId, source: 'desktop-owner' });
      this.grants = grants;
    }); this.queue = next.catch(() => {}); return next;
  }
  private async persist(grants: ReviewGrant[]): Promise<void> {
    const path = join(this.root, 'grants.json'), temporary = `${path}.${id<'WriteId'>()}.tmp`;
    await writeFile(temporary, JSON.stringify(grants), { mode: 0o600 }); await rename(temporary, path);
  }
  cancel(): void { for (const pending of this.pending.values()) pending.settle(false); }
  async close(): Promise<void> { this.cancel(); await this.queue; this.context.disable(); }
}
