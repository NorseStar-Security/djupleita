import { expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { id, digest, ScopeSchema } from '../packages/contracts/src/index.ts';
import type { SessionId } from '../packages/contracts/src/index.ts';
import { PolicyService } from '../packages/policy/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { Redactor } from '../packages/trajectory/src/index.ts';
import { ReviewService, allowanceHost } from '../packages/dsh-plugin/src/review.ts';
import type { ReviewOrigin } from '../packages/dsh-plugin/src/review.ts';
import { PentestRuntime } from '../packages/dsh-plugin/src/runtime.ts';
import { initialScopeDraft, scopeExample, scopePreview } from '../packages/ui/src/client/scope-draft.ts';
import { action, engagement, scope, policyConfig, testJudge, MemorySink } from './fixtures.ts';

const origin = (tool = 'first_tool'): ReviewOrigin => ({ sessionId: id<'SessionId'>(), tool,
  arguments: { fixture: tool }, argumentsHash: digest(tool), grants: new Set() });
async function question(review: ReviewService) {
  await expect.poll(() => review.snapshot().pending.length).toBeGreaterThan(0);
  return review.snapshot().pending[0]!;
}

it('automatically allows trusted bounded reads while retaining explicit denials, remote checks and unknown effects', async () => {
  const sink = new MemorySink(), judge = vi.fn(async () => { throw new Error('No provider available'); });
  const policy = new PolicyService(policyConfig, new ScopeService(scope()), { name: 'offline', judge }, engagement().model, sink, new Redactor());
  const read = action({ plugin: 'harness-control', destinations: [], trustedLocalRead: true });
  expect(await policy.evaluate({ action: read, signal: AbortSignal.timeout(1000) })).toMatchObject({ kind: 'allow', source: 'descriptor:harness-control:local-read' });
  expect(judge).not.toHaveBeenCalled();
  for (const changed of [action({ ...read, plugin: 'unadapted', effects: ['unknown'] }), action({ ...read, destinations: action().destinations }), action({ ...read, effects: ['delete'] })]) {
    expect((await policy.evaluate({ action: changed, signal: AbortSignal.timeout(1000) })).kind).toBe('ask');
  }
  const denied = new PolicyService({ ...policyConfig, rules: [{ id: 'owner', tools: ['*'], effects: ['read'], decision: 'deny', reason: 'Explicit owner restriction' }] }, new ScopeService(scope()), testJudge, engagement().model, sink, new Redactor());
  expect((await denied.evaluate({ action: read, signal: AbortSignal.timeout(1000) })).source).toBe('rule:owner');
});

it('persists host allowances across tools, chats, revisions and reloads, coalesces reviews, and keeps destructive effects separate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-host-grants-')), sink = new MemorySink();
  const review = new ReviewService(root, () => 'first', sink); await review.load(); review.connect();
  const destination = { url: 'https://api.example.test/first', purpose: 'model' as const };
  try {
    const a = origin(), b = origin('child_tool');
    const first = review.run(a, () => review.request('scope', destination, 'Model destination', AbortSignal.timeout(5000)));
    await question(review);
    const second = review.run(b, () => review.request('scope', { ...destination, url: 'http://api.example.test:8080/other' }, 'Other tool', AbortSignal.timeout(5000)));
    await expect.poll(() => review.snapshot().pending.length).toBe(2);
    await review.decide(review.snapshot().pending[0]!.id, a.sessionId, 'destination');
    expect(await first).toBe(true); expect(await second).toBe(true); expect(review.snapshot().pending).toHaveLength(0);
    const reopened = new ReviewService(root, () => 'changed-scope', sink); await reopened.load(); reopened.connect();
    try {
      const c = origin('different_tool');
      const scoped = new ScopeService(scope(), async () => [{ address: '127.0.0.1', family: 4 }], reopened);
      const grant = await reopened.run(c, () => scoped.authorize({ url: 'http://api.example.test:8123/changed', purpose: 'target' }));
      expect(grant.addresses[0]!.address).toBe('127.0.0.1');
      expect(reopened.snapshot().pending).toHaveLength(0);
      expect(() => scoped.check({ url: 'https://other.example.test/', purpose: 'model' })).toThrow('outside');
      const effects = reopened.run(c, () => reopened.request('policy', { effects: ['delete'] }, 'Independent destructive effect', AbortSignal.timeout(5000)));
      const effectQuestion = await question(reopened); expect(effectQuestion.host).toBeUndefined();
      await expect(reopened.decide(effectQuestion.id, c.sessionId, 'destination')).rejects.toThrow('no verified destination');
      await reopened.decide(effectQuestion.id, c.sessionId, 'reject'); expect(await effects).toBe(false);
      await reopened.revoke(reopened.snapshot().grants[0]!.id, c.sessionId);
      expect(() => scoped.check(destination)).toThrow('outside');
      expect(sink.events.some(event => event.type === 'policy/grant-used')).toBe(true);
    } finally { await reopened.close(); }
  } finally { await review.close(); await rm(root, { recursive: true, force: true }); }
});

it('accepts manually managed exact hosts and IPs and rejects broad or ambiguous host input', async () => {
  expect(allowanceHost('API.EXAMPLE.TEST.')).toBe('api.example.test');
  expect(allowanceHost('[::1]')).toBe('::1');
  for (const invalid of ['*.example.test', 'https://api.example.test', 'api.example.test:443', 'api.example.test/path', 'user@api.example.test', 'example.test?x']) expect(() => allowanceHost(invalid)).toThrow();
  const root = await mkdtemp(join(tmpdir(), 'djupleita-manual-host-')), review = new ReviewService(root, () => 'v1', new MemorySink());
  try {
    await review.addDestination('API.EXAMPLE.TEST.', id<'SessionId'>());
    expect(review.run(origin(), () => review.allows('scope', { url: 'https://api.example.test/any', purpose: 'model' }))).toBe(true);
    expect(review.allows('scope', { url: 'https://api.example.test/any', purpose: 'model' })).toBe(false);
    expect(review.allows('policy', { url: 'https://api.example.test/any', effects: ['delete'] })).toBe(false);
  } finally { await review.close(); await rm(root, { recursive: true, force: true }); }
});

it('does not spend the judgment budget while a human reviews a model connection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-judge-wait-')), review = new ReviewService(root, () => 'v1', new MemorySink()); review.connect();
  const who = origin(); let finished = false;
  try {
    const run = review.run(who, () => review.judgmentBudget(100, AbortSignal.timeout(5000), async signal => {
      expect(await review.request('scope', { url: 'https://api.example.test/', purpose: 'model' }, 'Model connection', signal)).toBe(true);
      signal.throwIfAborted(); finished = true; return 'judged';
    }));
    const pending = await question(review);
    await new Promise(resolve => setTimeout(resolve, 200)); expect(finished).toBe(false);
    await review.decide(pending.id, who.sessionId, 'once'); expect(await run).toBe('judged');
    await expect(review.judgmentBudget(10, new AbortController().signal, async () => new Promise(() => {}))).rejects.toThrow('timed out');
  } finally { await review.close(); await rm(root, { recursive: true, force: true }); }
});

it('keeps setup dismissal through restart and refresh without changing tool configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-banner-'));
  const config = { root, engagement: engagement(), policy: policyConfig, keychainHelper: '/unused', secrets: { async get() { return undefined; }, async set() {}, async remove() {} } };
  let runtime = await PentestRuntime.open(config, testJudge);
  try {
    const session = id<'SessionId'>(), before = (await runtime.toolSetup()).entries;
    await runtime.dismissSetupBanner(true, session); await runtime.close(); runtime = await PentestRuntime.open(config, testJudge);
    expect((await runtime.toolSetup(true)).bannerDismissed).toBe(true);
    expect((await runtime.toolSetup()).entries).toEqual(before);
    await runtime.dismissSetupBanner(false, session); expect((await runtime.toolSetup()).bannerDismissed).toBe(false);
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

it('shows the schema-valid scope example only for an entirely unconfigured editor and enforces exclusions', () => {
  const empty = { targets: [], exclusions: [], networks: [], services: { model: [], intelligence: [], telemetry: [] } };
  const shown = initialScopeDraft(empty), parsed = ScopeSchema.parse(JSON.parse(shown)), scopes = new ScopeService(parsed);
  expect(JSON.parse(shown)).toEqual(scopeExample);
  for (const url of ['https://example.test/', 'https://app.example.test/any/path']) expect(() => scopes.check({ url, purpose: 'target' })).not.toThrow();
  for (const url of ['https://excluded.example.test/', 'https://nested.excluded.example.test/', 'https://other.test/']) expect(() => scopes.check({ url, purpose: 'target' })).toThrow();
  for (const saved of [scope(), { ...empty, exclusions: ['saved.example.test'] }, { ...empty, networks: ['10.0.0.0/8'] }, { ...empty, services: { ...empty.services, model: scope().targets } }]) expect(JSON.parse(initialScopeDraft(saved))).toEqual(saved);
  expect(scopePreview(shown)).toContain('ports 80, 443');
  expect(scopePreview('{')).toContain('needs attention');
  expect(scopePreview(JSON.stringify({ ...empty, targets: ['*.example.test'] }))).toContain('host-rule object');
});
