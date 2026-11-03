import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { PentestRuntime } from '../packages/dsh-plugin/src/runtime.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';
import { id } from '../packages/contracts/src/index.ts';

it('renews an expired clock while retaining the request limit and checkpoint across restart', () => {
  let clock = 1000, saved: { requests: number; startedAt: number } | undefined;
  const base = engagement(); const config = { ...base, budget: { ...base.budget, requests: 2, durationMs: 100 } };
  const checkpoint = { save(value: { requests: number; startedAt: number }) { saved = value; } };
  const service = new EngagementService(config, () => clock, checkpoint);
  service.reserve().release(); clock += 101;
  expect(service.snapshot()).toMatchObject({ timeExhausted: true, remainingMs: 0, requests: 1 });
  expect(() => service.reserve()).toThrow('Renew time budget');
  service.renewTime();
  const reopened = new EngagementService(config, () => clock, { ...checkpoint, initial: saved! });
  expect(reopened.snapshot()).toMatchObject({ startedAt: clock, timeExhausted: false, requests: 1, remainingRequests: 1 });
  reopened.reserve().release(); reopened.renewTime();
  expect(() => reopened.reserve()).toThrow('request budget exhausted');
});
it('does not change the clock if persistence fails', () => {
  let clock = 1000, fail = false;
  const service = new EngagementService(engagement(), () => clock, { save() { if (fail) throw new Error('disk unavailable'); } });
  clock += 100; fail = true;
  expect(() => service.renewTime()).toThrow('disk unavailable'); expect(service.startedAt).toBe(1000);
});
it('records owner renewal, retains scope and grants, and persists the fresh clock on runtime reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-renewal-')); let clock = 1700000000000;
  const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const config = { root, engagement: engagement(), policy: policyConfig, keychainHelper: '/unused' };
  let runtime = await PentestRuntime.open(config, testJudge);
  try {
    runtime.engagement.reserve().release(); clock += config.engagement.budget.durationMs + 1;
    expect(runtime.engagement.snapshot().timeExhausted).toBe(true);
    const session = id<'SessionId'>(), scope = runtime.scope.scope, grants = runtime.review.snapshot().grants;
    await runtime.renewTimeBudget(session);
    expect(runtime.engagement.snapshot()).toMatchObject({ requests: 1, timeExhausted: false });
    expect(runtime.scope.scope).toEqual(scope); expect(runtime.review.snapshot().grants).toEqual(grants);
    expect((await runtime.trajectories.read(session)).some(event => event.type === 'engagement/time-renewal')).toBe(true);
    await runtime.close(); runtime = await PentestRuntime.open(config, testJudge);
    expect(runtime.engagement.snapshot()).toMatchObject({ startedAt: clock, requests: 1, timeExhausted: false });
  } finally { await runtime.close(); now.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
