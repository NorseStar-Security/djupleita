import { it, expect, vi } from 'vitest';
import { PolicyService, SelectedModelJudge, JevJudge } from '../packages/policy/src/index.ts';
import type { StructuredGenerator } from '../packages/policy/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { Redactor } from '../packages/trajectory/src/index.ts';
import { action, scope, policyConfig, testJudge, MemorySink } from './fixtures.ts';

function service(provider = testJudge, config = policyConfig) {
  const sink = new MemorySink();
  return { sink, policy: new PolicyService(config, new ScopeService(scope()), provider, { provider: 'selected', model: 'chosen' }, sink, new Redactor()) };
}
it('permits bounded active red-team operations through the selected judgment provider', async () => {
  const judge = vi.fn(testJudge.judge);
  const { policy, sink } = service({ name: 'selected', judge });
  expect((await policy.evaluate({ action: action({ effects: ['modify'], reversible: true }), signal: AbortSignal.timeout(1000) })).kind).toBe('allow');
  expect(judge.mock.calls[0]?.[1]).toEqual({ provider: 'selected', model: 'chosen' });
  expect(sink.events.map(event => event.type)).toEqual(['policy/judgment-request', 'policy/judgment-result', 'policy/decision']);
});
it('denies out-of-scope calls without asking a model or approval answerer', async () => {
  const judge = vi.fn(testJudge.judge), approve = vi.fn(async () => true);
  const { policy } = service({ name: 'test', judge });
  await expect(policy.authorize({ action: action({ destinations: [{ url: 'https://outside.test/', purpose: 'target' }] }), signal: AbortSignal.timeout(1000) }, approve)).rejects.toThrow(/outside/);
  expect(judge).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
});
it('requires a fresh approval for each deletion and fails closed without an answerer', async () => {
  const { policy, sink } = service();
  const deletion = action({ effects: ['delete'], reversible: false });
  await expect(policy.authorize({ action: deletion, signal: AbortSignal.timeout(1000) })).rejects.toThrow(/one-shot/);
  const approve = vi.fn(async () => true);
  await policy.authorize({ action: deletion, signal: AbortSignal.timeout(1000) }, approve);
  await policy.authorize({ action: deletion, signal: AbortSignal.timeout(1000) }, approve);
  expect(approve).toHaveBeenCalledTimes(2);
  expect(sink.events.filter(event => event.type === 'policy/approval')).toHaveLength(3);
});
it('retains destructive-effect review when target scope management is off', async () => {
  const policy = new PolicyService(policyConfig, new ScopeService({ ...scope(), enabled: false }), testJudge,
    { provider: 'fixture', model: 'fixture' }, new MemorySink(), new Redactor());
  await expect(policy.authorize({ action: action({ destinations: [{ url: 'http://outside.example.test:8123/', purpose: 'target' }],
    effects: ['delete'], reversible: false }), signal: AbortSignal.timeout(1000) })).rejects.toThrow('one-shot');
});
it('detects action substitution while approval is pending', async () => {
  const { policy } = service(); const deletion = action({ effects: ['delete'], reversible: false });
  await expect(policy.authorize({ action: deletion, signal: AbortSignal.timeout(1000) }, async () => {
    deletion.arguments = { different: 'operation' }; return true;
  })).rejects.toThrow(/changed/);
});
it('asks when model inference fails, and preserves explicit rule denials', async () => {
  const { policy } = service({ name: 'unavailable', async judge() { throw new Error('provider unavailable'); } });
  expect((await policy.evaluate({ action: action(), signal: AbortSignal.timeout(1000) })).kind).toBe('ask');
  const custom = service(testJudge, { ...policyConfig, rules: [{ id: 'no-reboot', tools: ['device_*'], effects: ['disrupt'], decision: 'deny', reason: 'Engagement excludes rebooting devices' }] });
  expect((await custom.policy.evaluate({ action: action({ tool: 'device_reboot', effects: ['disrupt'] }), signal: AbortSignal.timeout(1000) })).source).toBe('rule:no-reboot');
});
it('sends redacted state and the selected model to the structured model adapter', async () => {
  const generate = vi.fn<StructuredGenerator>(async () => ({ deletion: 0, irreversible: 0, disruption: 0, confidence: 1, reason: 'Read only' }));
  const judge = new SelectedModelJudge(generate);
  await judge.judge(action(), { provider: 'a', model: 'b' }, AbortSignal.timeout(1000));
  expect(generate.mock.calls[0]?.[0]).toMatchObject({ model: { provider: 'a', model: 'b' } });
});
it('parses Jev typed probabilities and falls back to the selected model on invalid output', async () => {
  const send = vi.fn(async () => ({ answers: { deletion: { noul: 0.01 }, irreversible: { noul: 0.02 }, disruption: { noul: 0.03 } } }));
  const judge = new JevJudge(send, 'jev-pinned');
  expect((await judge.judge(action(), { provider: 'a', model: 'b' }, AbortSignal.timeout(1000))).deletion).toBe(0.01);
  const fallback = vi.fn(testJudge.judge);
  const invalid = new JevJudge(async () => ({}), 'jev-pinned', { name: 'fallback', judge: fallback });
  await invalid.judge(action(), { provider: 'a', model: 'b' }, AbortSignal.timeout(1000));
  expect(fallback).toHaveBeenCalledOnce();
});
