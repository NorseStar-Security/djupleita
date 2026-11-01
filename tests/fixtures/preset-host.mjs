/** Keyless fixture for the shipped pentest preset and its real host services. */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upstream = new URL('../../vendor/deepseek-harness/', import.meta.url);
export const load = path => import(new URL(`${path}/lib/index.js`, upstream));

export async function presetHost() {
  const { Context } = await load('vendor/cordis');
  const { default: Loader } = await load('vendor/loader');
  const { default: Group } = await load('vendor/group');
  const { mountAgentLoopTestDependencies } = await load('packages/test-support/agent-loop-testkit');
  const modules = new Map(await Promise.all([
    ['@deepseek-ai/dsh-persona', 'packages/preset/persona'],
    ['@deepseek-ai/dsh-compaction-basic', 'packages/compaction/compaction-basic'],
    ['@deepseek-ai/dsh-command-compact', 'packages/compaction/command-compact'],
    ['@deepseek-ai/dsh-compaction-tool-result-pruner', 'packages/compaction/compaction-tool-result-pruner'],
    ['@deepseek-ai/dsh-command-goal', 'packages/goal/command-goal'],
    ['@deepseek-ai/dsh-tool-goal', 'packages/goal/tool-goal'],
    ['@deepseek-ai/dsh-tool-subagent', 'packages/subagent/tool-subagent'],
    ['@deepseek-ai/dsh-tool-subagent-control', 'packages/subagent/tool-subagent-control'],
  ].map(async ([name, path]) => [name, await load(path)])));
  const ctx = new Context(), root = await mkdtemp(join(tmpdir(), 'djupleita-preset-host-'));
  try {
    await ctx.plugin(Loader);
    ctx.loader.builtins.group = Group;
    ctx.loader.internal = { version: 'v2', async import(name) {
      assert(modules.has(name), `Unexpected preset module: ${name}`);
      return modules.get(name);
    } };
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true });
    await ctx.plugin((await load('packages/session/session-persistence-jsonl')), { root: join(root, 'sessions') });
    // Only corpus and point reads are needed; search is outside this fixture.
    const { default: SessionQuery } = await load('packages/session-query/session-query');
    class FixtureQuery extends SessionQuery {
      searchSessions() { throw new Error('Search is not used in this fixture'); }
      searchEvents() { throw new Error('Search is not used in this fixture'); }
    }
    await ctx.plugin(FixtureQuery);
    for (const path of ['packages/core/agent-loop', 'packages/llm/token-meter', 'packages/interaction/commands',
      'packages/goal/goal', 'packages/goal/goal-round-driver', 'packages/subagent/subagent',
      'packages/subagent/subagent-spawn-in-process', 'packages/subagent/subagent-fork-in-process']) {
      const module = await load(path);
      await ctx.plugin(module.default ?? module, path === 'packages/core/agent-loop' ? { agents: [] } : {});
    }
    const { default: AgentPresets } = await load('packages/preset/agent-preset-registry');
    await ctx.plugin(AgentPresets, { default: 'pentest' });
    const preset = JSON.parse(await readFile(new URL('../../configs/pentest-preset.json', import.meta.url), 'utf8'));
    const unregister = await ctx.agentPresets.register(preset);
    ctx.effect(() => unregister);
    return { ctx, root, async close() { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); } };
  } catch (error) { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); throw error; }
}
