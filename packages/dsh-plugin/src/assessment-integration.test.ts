import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import Skills from '@deepseek-ai/dsh-skill';
import { SessionId as HarnessSessionId } from '@deepseek-ai/dsh-session';
import LlmRuntime, { ToolCallId, LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { id, digest } from '@dsh-pentest/contracts';
import { PentestRuntime, ToolPolicy, AssessmentTools, AssessmentSkills, ValidationTools, ModelEgressPlugin } from './index.ts';
import { DesktopChannel } from './rpc.ts';
import { assessmentEndpoints } from './assessment-rpc.ts';
import { engagement, policyConfig, testJudge } from '../../../tests/fixtures.ts';

it('loads bundled skills through the native registry and guarded tool pipeline, then removes optional tools on disable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-assessment-plugin-')), ctx = new Context();
  const runtime = await PentestRuntime.open({ root, engagement: engagement(), policy: policyConfig, keychainHelper: '/unused' }, testJudge);
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Native); await ctx.plugin(Skills);
    await ctx.plugin({ name: 'assessment-fixture', apply(inner: Context) { inner.provide('pentest', runtime); } });
    await ctx.plugin(ToolPolicy);
    const assessment = await ctx.plugin(AssessmentTools), skills = await ctx.plugin(AssessmentSkills), validation = await ctx.plugin(ValidationTools);
    const agent = { id: HarnessSessionId(id<'SessionId'>()), model: { current: () => ({ provider: 'fixture', model: 'fixture' }) } } as Agent;
    const invoke = async (name: string, args: unknown) => {
      const pipeline = new ToolExecutionPipeline(ctx);
      const prepared = await pipeline.prepare({ name, arguments: args, callId: ToolCallId(id<'CallId'>()), agent, signal: AbortSignal.timeout(5000) });
      const result = await pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared);
      await runtime.trajectories.flush(); return result;
    };
    expect((await ctx.skills.list()).filter(item => item.provider === 'djupleita-assessment')).toHaveLength(5);
    expect((await ctx.skills.get('djupleita-proof'))?.content).toContain('negative control');
    const workflowPrompt = (await ctx.systemPrompt.assemble()).contexts.map(item => item.text).join('\n');
    expect(workflowPrompt).toContain('not a prerequisite for every active test');
    expect(workflowPrompt).toContain('owner-reviewed deterministic proofs');
    expect(workflowPrompt).not.toContain('load pentest_skill djupleita-assessment before testing');
    ctx.tools.register({ name: 'skill', description: 'Scoped native skill fixture', parameters: { type: 'object' },
      output: { schema: { type: 'object' }, render: () => [] }, async execute() { throw new Error('Scoped catalog has no bundled skill'); } });
    expect((await invoke('skill', { name: 'djupleita-assessment' })).value).toMatchObject({ name: 'djupleita-assessment', content: expect.stringContaining('pentest_status') });
    expect((await invoke('skill', { name: 'missing-fixture' })).isError).toBe(true);
    const loaded = await invoke('pentest_skill', { name: 'djupleita-assessment' });
    expect(loaded.isError).toBe(false); expect(loaded.value).toMatchObject({ name: 'djupleita-assessment', content: expect.stringContaining('Once a structured run is joined, follow its readiness, budget, coverage and completion gates.') });
    const planned = await invoke('pentest_assessment', { operation: 'plan', plan: { title: 'Native pipeline plan', maxRequests: 12,
      cells: [{ surface: 'https://app.example.test/objects/1', method: 'GET', input: 'object', family: 'authorization' }] } });
    expect(planned.isError).toBe(false); expect(runtime.assessment.runs()).toHaveLength(1);
    const configured = await invoke('pentest_assessment', { operation: 'configure', runId: runtime.assessment.runs()[0]!.id, expectedValue: 'invented' });
    expect(configured.isError).toBe(true); expect(runtime.assessment.runs()[0]!.assertions).toEqual([]);
    expect(ctx.tools.get('pentest_review_finding')).toBeUndefined();
    await validation.dispose(); await skills.dispose(); await assessment.dispose();
    expect(ctx.tools.get('pentest_validate')).toBeUndefined(); expect(ctx.tools.get('pentest_assessment')).toBeUndefined();
    expect(await ctx.skills.list()).toEqual([]);
    expect(runtime.assessment.runs()).toHaveLength(1);
    expect(runtime.inventory().filter(item => ['assessment', 'validation'].includes(item.plugin))).toEqual([]);
  } finally { await ctx.fiber.dispose(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

it('restricts every assessment owner route to authenticated owner peers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-assessment-owner-')), ctx = new Context();
  const runtime = await PentestRuntime.open({ root, engagement: engagement(), policy: policyConfig, keychainHelper: '/unused' }, testJudge);
  let connection!: HostConnectionService;
  try {
    await ctx.plugin({ name: 'assessment-owner-fixture', apply(inner: Context) {
      inner.provide('pentest', runtime); connection = new HostConnectionService(inner, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
    } });
    await ctx.plugin(DesktopChannel);
    const shared = connection.createSharedFetchHandler('/api'), other = { principal: { kind: 'api-key' } } as unknown as typeof connection.browserPeer;
    for (const endpoint of [...assessmentEndpoints, 'budget/renew-time']) {
      const request = () => new Request(`http://host/api/pentest/${endpoint}`, { method: 'POST', body: JSON.stringify({
        type: 'client-request', rpcId: 'fixture', method: `pentest/${endpoint}`, payload: {},
      }) });
      expect((await shared.fetch(request(), other)).status).toBe(403);
      if (endpoint === 'assessment/list') {
        const response = await shared.fetch(request(), connection.browserPeer);
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ result: { ok: true, value: { runs: [] } } });
      }
    }
  } finally { await ctx.fiber.dispose(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});

it('counts dispatch usage once across nested LLM hooks, including missing usage, without a model request', async () => {
  class FixtureAdapter extends LlmAdapter {
    includeUsage = true;
    override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
      return { model: await this.resolveModel(provider, model), stream: options => this.stream(options) };
    }
    async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (this.includeUsage) yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const root = await mkdtemp(join(tmpdir(), 'djupleita-assessment-meter-')), ctx = new Context();
  const runtime = await PentestRuntime.open({ root, engagement: engagement(), policy: policyConfig, keychainHelper: '/unused' }, testJudge);
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin({ name: 'assessment-meter-fixture', apply(inner: Context) { inner.provide('pentest', runtime); } });
    await ctx.plugin(ModelEgressPlugin);
    const adapter = new FixtureAdapter(); ctx.llm.registerAdapter(['openai'], adapter);
    const session = id<'SessionId'>();
    const run = runtime.assessment.create({ title: 'Meter fixture', maxRequests: 12,
      cells: [{ surface: 'https://app.example.test/objects/1', method: 'GET', input: 'object', family: 'authorization' }] }, session);
    const origin = { sessionId: session, tool: 'fixture_model', argumentsHash: digest({}), arguments: {}, grants: new Set<string>() };
    const collect = async () => runtime.review.run(origin, async () => {
      for await (const _chunk of ctx.llm.stream({ provider: 'openai', model: 'fixture', messages: [] })) { /* Synthetic chunks only. */ }
    });
    await collect();
    expect(runtime.assessment.scorecard(run.id)).toMatchObject({ model: { calls: 1, reportedTokens: 125, missingUsage: 0, costUsd: null } });
    adapter.includeUsage = false; await collect();
    expect(runtime.assessment.scorecard(run.id)).toMatchObject({ model: { calls: 2, reportedTokens: 125, missingUsage: 1, costUsd: null } });
  } finally { await ctx.fiber.dispose(); await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
