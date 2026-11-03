import { expect, it, vi } from 'vitest';
import { PolicyService } from '../packages/policy/src/index.ts';
import type { PolicyConfig } from '../packages/policy/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { Redactor } from '../packages/trajectory/src/index.ts';
import { action, scope, policyConfig, testJudge, MemorySink } from './fixtures.ts';
import { literalArguments, reconArguments, workspacePath } from '../packages/dsh-plugin/src/action-profile.ts';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const signal = () => AbortSignal.timeout(2000);
const unknown = () => action({ tool: 'bash', plugin: 'harness-execution', arguments: { command: 'printf fixture' }, destinations: [], effects: ['unknown'], reversible: false });
function service(config: PolicyConfig = { ...policyConfig, profile: 'red-team' }, judge = vi.fn(testJudge.judge)) {
  return { judge, policy: new PolicyService(config, new ScopeService(scope()), { name: 'fixture-judge', judge }, { provider: 'fixture', model: 'selected' }, new MemorySink(), new Redactor()) };
}
it('sends unknown shell effects to the selected judge without an owner grant', async () => {
  const { judge, policy } = service(); const approve = vi.fn(async () => false);
  expect((await policy.authorize({ action: unknown(), signal: signal() }, approve)).kind).toBe('allow');
  expect(judge).toHaveBeenCalledOnce(); expect(judge.mock.calls[0]?.[0].scopeContext).toEqual(scope()); expect(approve).not.toHaveBeenCalled();
});
it('preserves conservative behavior for existing profiles and lets operators select unknown review or block', async () => {
  for (const [config, expected] of [[policyConfig, 'ask'], [{ ...policyConfig, profile: 'red-team', redTeam: { unknown: 'ask' } }, 'ask'], [{ ...policyConfig, profile: 'red-team', redTeam: { unknown: 'deny' } }, 'deny']] as const) {
    const { policy, judge } = service(config); expect((await policy.evaluate({ action: unknown(), signal: signal() })).kind).toBe(expected); expect(judge).not.toHaveBeenCalled();
  }
});
it.each(['research', 'recon', 'workspace'] as const)('applies configurable %s decisions without inference', async activity => {
  for (const expected of ['allow', 'ask', 'deny'] as const) {
    const { policy, judge } = service({ ...policyConfig, profile: 'red-team', redTeam: { [activity]: expected } });
    const result = await policy.evaluate({ action: action({ activity, effects: [activity === 'workspace' ? 'create' : 'read'] }), signal: signal() });
    expect(result.kind).toBe(expected); expect(result.source).toBe(`profile:red-team:${activity}`); expect(judge).not.toHaveBeenCalled();
  }
});
it('checks scope and exclusions before a permissive judge or routine operation allowance', async () => {
  const { policy, judge } = service(); const approve = vi.fn(async () => true);
  await expect(policy.authorize({ action: action({ activity: 'recon', destinations: [{ url: 'https://example.test/', purpose: 'target' }] }), signal: signal() }, approve)).rejects.toThrow('outside');
  expect(judge).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
});
it('keeps known deletion, overwrite and disruption out of the judge and blocks without owner override when configured', async () => {
  for (const effect of ['delete', 'overwrite', 'disrupt'] as const) {
    const { policy, judge } = service({ ...policyConfig, profile: 'red-team', redTeam: { destructive: 'deny' } });
    const approve = vi.fn(async () => true);
    await expect(policy.authorize({ action: action({ activity: 'recon', effects: [effect], reversible: false }), signal: signal() }, approve)).rejects.toThrow('requires your decision');
    expect(judge).not.toHaveBeenCalled(); expect(approve).not.toHaveBeenCalled();
  }
});
it('asks on uncertain, failed, malformed and high-risk judgments', async () => {
  for (const judge of [async () => ({ deletion: 0, irreversible: 0, disruption: 0, confidence: 0.2, reason: 'Unclear' }), async () => { throw new Error('offline'); }, async () => ({}) as never,
    async () => ({ deletion: 0, irreversible: 0, disruption: 0.9, confidence: 0.99, reason: 'Availability impact' })]) {
    const { policy } = service(undefined, vi.fn(judge));
    expect((await policy.evaluate({ action: unknown(), signal: signal() })).kind).toBe('ask');
  }
});
it('requires owner review when unknown-effect judgment times out', async () => {
  const { policy, judge } = service({ ...policyConfig, profile: 'red-team', judgmentTimeoutMs: 10 }, vi.fn(() => new Promise<never>(() => {})));
  const result = await policy.evaluate({ action: unknown(), signal: signal() });
  expect(result.kind).toBe('ask'); expect(result.reasons.join(' ')).toContain('timed out'); expect(judge).toHaveBeenCalledOnce();
});
it('honors destructive blocks for high-risk model judgments while asking on low confidence', async () => {
  for (const [confidence, expected] of [[0.99, 'deny'], [0.2, 'ask']] as const) {
    const { policy } = service({ ...policyConfig, profile: 'red-team', redTeam: { destructive: 'deny' } }, vi.fn(async () => ({ deletion: 0.9, irreversible: 0.9, disruption: 0.9, confidence, reason: 'Potential destructive command' })));
    expect((await policy.evaluate({ action: unknown(), signal: signal() })).kind).toBe(expected);
  }
});
it('judges unadapted tools instead of trusting self-asserted routine activity metadata', async () => {
  const { policy, judge } = service();
  expect((await policy.evaluate({ action: action({ plugin: 'unadapted', activity: 'research', effects: ['unknown'] }), signal: signal() })).kind).toBe('allow'); expect(judge).toHaveBeenCalledOnce();
});
it('recognizes only literal recon argv and refuses shell evaluation and unsupported flags', () => {
  expect(reconArguments(literalArguments('subfinder -d app.example.test -silent -json')!, ['crtsh'])).toEqual({ tool: 'subfinder', target: 'app.example.test' });
  expect(reconArguments(literalArguments('httpx -u "https://app.example.test/" -threads 2 -rl 3 -o output.jsonl')!, ['crtsh'])).toMatchObject({ tool: 'httpx', target: 'https://app.example.test/', concurrency: 2, rate: 3, output: 'output.jsonl' });
  for (const command of ['httpx -u $(cat target)', 'httpx -u `cat target`', 'httpx -u $TARGET', 'subfinder -d app.example.test | sh', 'subfinder -d app.example.test; rm file', 'httpx -u https://app.example.test/ > file', 'httpx -u https://app.example.test/\nrm file']) expect(literalArguments(command)).toBeUndefined();
  for (const command of ['httpx -u https://app.example.test/ -proxy http://elsewhere.example.test', 'subfinder -d app.example.test -s another', 'httpx -u https://app.example.test/ -x DELETE']) expect(reconArguments(literalArguments(command)!, ['crtsh'])).toBeUndefined();
});
it('contains workspace paths canonically and rejects private state and symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-profile-paths-'));
  try { const work = join(root, 'work'); await mkdir(work); await symlink(root, join(work, 'escape'));
    expect(await workspacePath(work, work, 'new.txt')).toBe(join(work, 'new.txt'));
    expect(await workspacePath(work, work, '../outside')).toBeUndefined();
    expect(await workspacePath(work, work, 'escape/secret')).toBeUndefined();
    expect(await workspacePath(work, work, '.pentest/settings.json')).toBeUndefined();
    await mkdir(join(work, '.pentest')); await symlink(join(work, '.pentest'), join(work, 'alias'));
    expect(await workspacePath(work, work, 'alias/settings.json')).toBeUndefined();
    expect(await workspacePath(work, work, '.env')).toBeUndefined();
    expect(await workspacePath('/', '/', 'tmp/output')).toBeUndefined();
  } finally { await rm(root, { recursive: true, force: true }); }
});
