import { expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, id } from '../packages/contracts/src/index.ts';
import { ReviewService } from '../packages/dsh-plugin/src/review.ts';
import type { ReviewOrigin } from '../packages/dsh-plugin/src/review.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { scope, MemorySink } from './fixtures.ts';

const origin = (args = { url: 'https://outside.test/objects/1', method: 'DELETE' }): ReviewOrigin => ({
  sessionId: id<'SessionId'>(), tool: 'pentest_http', callId: id<'CallId'>(), arguments: args, argumentsHash: digest(args), grants: new Set(),
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-review-')), sink = new MemorySink(); let revision = 'v1';
  const review = new ReviewService(root, () => revision, sink); await review.load();
  return { root, sink, review, disconnect: review.connect(), revise() { revision = 'v2'; } };
}
async function pending(review: ReviewService) {
  await expect.poll(() => review.snapshot().pending.length).toBeGreaterThan(0);
  return review.snapshot().pending[0]!;
}
it('holds execution, allows once only for the exact call and records the owner decision', async () => {
  const f = await fixture(), first = origin(); let executed = 0;
  try {
    const run = () => f.review.request('policy', { effects: ['delete'] }, 'Deletion blocked', AbortSignal.timeout(5000));
    const operation = f.review.run(first, async () => { if (await run()) executed++; });
    const question = await pending(f.review); expect(executed).toBe(0);
    await expect(f.review.decide(question.id, id<'SessionId'>(), 'once')).rejects.toThrow('no longer pending');
    await f.review.decide(question.id, first.sessionId, 'once'); await operation;
    expect(executed).toBe(1); expect(f.review.snapshot().grants).toHaveLength(0);
    const second = origin(); const retry = f.review.run(second, run);
    await pending(f.review); expect(executed).toBe(1);
    f.review.cancel(); expect(await retry).toBe(false);
    expect(f.sink.events.some(event => event.type === 'policy/review-decided' && JSON.stringify(event.data).includes('desktop-owner'))).toBe(true);
  } finally { await f.review.close(); }
});
it('persists always for matching inputs, isolates changed inputs, invalidates revisions and revokes', async () => {
  const f = await fixture(), first = origin();
  const run = (review: ReviewService) => review.request('policy', { effects: ['delete'] }, 'Deletion blocked', AbortSignal.timeout(5000));
  try {
    const waiting = f.review.run(first, () => run(f.review));
    await f.review.decide((await pending(f.review)).id, first.sessionId, 'always'); expect(await waiting).toBe(true);
    const reopened = new ReviewService(f.root, () => 'v1', f.sink); await reopened.load(); reopened.connect();
    expect(await reopened.run(origin(), () => run(reopened))).toBe(true);
    const changed = reopened.run(origin({ url: 'https://outside.test/objects/2', method: 'DELETE' }), () => run(reopened));
    await pending(reopened); reopened.cancel(); expect(await changed).toBe(false);
    await reopened.revoke(reopened.snapshot().grants[0]!.id, first.sessionId);
    expect(reopened.snapshot().grants).toHaveLength(0); await reopened.close();
    f.revise(); const revised = f.review.run(origin(), () => run(f.review));
    await pending(f.review); f.review.cancel(); expect(await revised).toBe(false);
  } finally { await f.review.close(); }
});
it('discards cancelled and duplicate answers and fails closed without an owner interface', async () => {
  const f = await fixture(), first = origin(), controller = new AbortController();
  try {
    const waiting = f.review.run(first, () => f.review.request('adapter', {}, 'Unknown destinations', controller.signal));
    const question = await pending(f.review); controller.abort(); expect(await waiting).toBe(false);
    await expect(f.review.decide(question.id, first.sessionId, 'always')).rejects.toThrow('no longer pending');
    expect(f.review.snapshot().grants).toHaveLength(0);
    f.disconnect();
    expect(await f.review.run(origin(), () => f.review.request('policy', {}, 'Blocked', AbortSignal.timeout(5000)))).toBe(false);
  } finally { await f.review.close(); }
});
it('reviews each exact destination and private resolved address, keeping one-shot scope local to its call', async () => {
  const f = await fixture(), first = origin();
  const scoped = new ScopeService(scope(), async () => [{ address: '127.0.0.1', family: 4 }], f.review);
  const destination = { url: 'https://outside.test/objects/1', purpose: 'target' as const };
  try {
    const operation = f.review.run(first, () => scoped.authorize(destination, AbortSignal.timeout(5000)));
    const scopeQuestion = await pending(f.review); expect(scopeQuestion.category).toBe('scope');
    await f.review.decide(scopeQuestion.id, first.sessionId, 'once');
    const networkQuestion = await pending(f.review); expect(networkQuestion.category).toBe('network');
    await f.review.decide(networkQuestion.id, first.sessionId, 'once');
    expect((await operation).addresses[0]?.address).toBe('127.0.0.1');
    expect(() => scoped.check(destination)).toThrow('outside');
    const redirected = f.review.run(first, () => scoped.ensure({ ...destination, url: 'https://different.test/' }, AbortSignal.timeout(5000)));
    const blocked = await pending(f.review); expect(blocked.details).toMatchObject({ url: 'https://different.test/' });
    await f.review.decide(blocked.id, first.sessionId, 'reject'); await expect(redirected).rejects.toThrow('outside');
  } finally { await f.review.close(); }
});

it('does not retain an always grant when recording the owner decision fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-audit-failure-')), sink = new MemorySink();
  const review = new ReviewService(root, () => 'v1', { async append(session, type, data) {
    if (type === 'policy/review-decided') throw new Error('Audit store unavailable');
    return sink.append(session, type, data);
  } });
  await review.load(); review.connect(); const first = origin();
  try {
    const waiting = review.run(first, () => review.request('policy', {}, 'Blocked', AbortSignal.timeout(5000)));
    const question = await pending(review);
    await expect(review.decide(question.id, first.sessionId, 'always')).rejects.toThrow('Audit store unavailable');
    expect(review.snapshot().grants).toHaveLength(0); review.cancel(); expect(await waiting).toBe(false);
    const reopened = new ReviewService(root, () => 'v1', sink); await reopened.load();
    expect(reopened.snapshot().grants).toHaveLength(0); await reopened.close();
  } finally { await review.close(); }
});
