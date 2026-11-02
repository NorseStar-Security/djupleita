import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import { PluginConfigSchema } from './runtime.ts';
import { id, digest } from '@dsh-pentest/contracts';
import { applyCore, LearningTools } from './index.ts';
import { engagement, policyConfig, testJudge } from '../../../tests/fixtures.ts';

it('promotes a reviewed procedure into agent context, persists it across restart and revokes future use without changing scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-procedure-')), session = id<'SessionId'>(), runId = id<'StudyId'>();
  const config = { engagement: engagement(), policy: policyConfig, root, keychainHelper: '/unused', plugins: PluginConfigSchema.parse({ learning: { python: '/unused', script: '/unused', datasets: root } }) };
  const start = async () => {
    const ctx = new Context(); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Native);
    await ctx.plugin({ name: 'learning-model-fixture', apply(inner: Context) { inner.provide('llm', {}); } });
    await ctx.plugin({ name: 'learning-core-fixture', inject: ['tools', 'llm'], apply(inner: Context) { return applyCore(inner, config, { judge: testJudge }); } });
    await expect.poll(() => !!ctx.pentest).toBe(true);
    await ctx.plugin(LearningTools);
    return ctx;
  };
  const text = 'Establish object ownership and compare equivalent-role identities using returned object data.';
  let ctx = await start();
  try {
    const directory = join(ctx.pentest.root, 'studies', runId); await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'report.json'), JSON.stringify({ kind: 'authz-procedure', runId, datasetHash: 'fixture-hash', seed: 42, engine: 'gepa/fixture',
      procedure: { baseline: 'Status-only fixture', candidate: text }, candidates: [{ procedure: text, validationScore: 1, parents: [0] }],
      evaluations: { baseline: [], candidate: [] }, scores: { train: { baseline: 0, candidate: 1 }, validation: { baseline: 0, candidate: 1 }, test: { baseline: 0, candidate: 1 } },
      model: { provider: 'fixture', model: 'fixture' }, evaluatorVersion: 'authz-evidence-v1',
      budget: { searchEvaluations: 12, maxSearchEvaluations: 24, modelCalls: 12, maxModelCalls: 100, inputChars: 1000, outputChars: 1000 }, limitation: 'Unit fixture' }));
    const context = async () => (await ctx.systemPrompt.assemble()).contexts.map(item => item.text).join('\n');
    expect(await context()).not.toContain(text);
    const scopeHash = digest(ctx.pentest.scope.scope);
    const inFlight = ctx.pentest.signal(new AbortController().signal);
    await ctx.pentest.promoteStudy(runId, session);
    expect(inFlight.aborted).toBe(false);
    expect(await context()).toContain(text); expect(await context()).toContain('never grants target access');
    expect(digest(ctx.pentest.scope.scope)).toBe(scopeHash);
    await ctx.fiber.dispose(); ctx = await start();
    expect(await context()).toContain(text);
    expect(await ctx.pentest.snapshot(session)).toMatchObject({ procedure: { runId, text } });
    await ctx.pentest.revokeProcedure(session);
    expect(await context()).not.toContain(text); expect(digest(ctx.pentest.scope.scope)).toBe(scopeHash);
    await ctx.fiber.dispose(); ctx = await start(); expect(await context()).not.toContain(text);
  } finally { await ctx.fiber.dispose(); }
});
