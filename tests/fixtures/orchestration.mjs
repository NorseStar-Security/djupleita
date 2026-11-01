/** Real preset, loop, child backends and pentest policy; the model is entirely local. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { load, presetHost } from './preset-host.mjs';
import { applyCore, HttpTools } from '../../packages/dsh-plugin/lib/index.js';

const { LlmAdapter, ToolCallId, createUserMessage } = await load('packages/llm/llm');
const { SessionId } = await load('packages/core/session');
const { ToolExecutionPipeline } = await import('../../vendor/deepseek-harness/packages/core/tools/lib/pipeline.js');
const host = await presetHost(), { ctx } = host;
const text = value => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: value } },
  { type: 'finish', reason: { kind: 'stop' } },
];
const calls = entries => [
  ...entries.flatMap(([name, args], index) => {
    const id = ToolCallId(randomUUID()), argumentsJson = JSON.stringify(args);
    return [{ type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: argumentsJson },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: argumentsJson } }];
  }), { type: 'finish', reason: { kind: 'tool-calls' } },
];
const logs = new Map(), stages = new Map();
let parent, goalAgent, rootStarted = false, followups = 0, rawRan = false, childStarts = 0;
let releaseChildren;
const allChildrenStarted = new Promise(resolve => { releaseChildren = resolve; });
const required = ['subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'list_subagent_models',
  'create_goal', 'get_goal', 'update_goal', 'pentest_status', 'pentest_http'];
try {
  await applyCore(ctx, { root: join(host.root, 'engagements'), keychainHelper: '/unused',
    engagement: { id: randomUUID(), name: 'Orchestration fixture', objectives: ['Local fixture only'],
      scope: { targets: [], exclusions: [], networks: [], services: { model: [], intelligence: [], telemetry: [] } },
      model: { provider: 'fixture', model: 'fixture' },
      budget: { requests: 100, concurrency: 8, durationMs: 60000, requestsPerSecond: 100, maxDepth: 4, maxResponseBytes: 65536 } },
    policy: { minimumConfidence: 0.8, deletionThreshold: 0.5, disruptionThreshold: 0.7, judgmentTimeoutMs: 1000, rules: [] },
  }, { judge: { name: 'fixture', async judge() { return { deletion: 0, irreversible: 0, disruption: 0, confidence: 1, reason: 'Local fixture control' }; } } });
  await ctx.plugin(HttpTools);
  ctx.tools.register({ name: 'raw_socket', description: 'Unadapted fixture', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [] }, async execute() { rawRan = true; return true; } });
  ctx.on('session/event', (session, event) => {
    const events = logs.get(session.id) ?? []; events.push(event); logs.set(session.id, events);
  });
  class FixtureModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 128000 } }; }
    async *stream(options) {
      const users = options.messages.filter(message => message.role === 'user').flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text);
      const child = users.find(value => value.startsWith('CHILD_FIXTURE_') || value.startsWith('FORK_FIXTURE'));
      let response;
      if (child) {
        for (const tool of required) assert(options.tools.some(definition => definition.name === tool), `Child missing ${tool}`);
        const stage = stages.get(child) ?? 0; stages.set(child, stage + 1);
        if (stage === 0) {
          if (child.startsWith('CHILD')) { if (++childStarts === 6) releaseChildren(); await allChildrenStarted; }
          response = calls([['pentest_status', {}], ['pentest_http', { url: 'https://outside.invalid/' }], ['raw_socket', {}],
            ['subagent', { description: 'Depth limit fixture', prompt: 'Never reached grandchild' }]]);
        } else { if (users.some(value => value.includes('FOLLOWUP_FIXTURE'))) followups++; response = text('Child fixture complete'); }
      } else if (users.some(value => value.includes('ROOT_FIXTURE')) && !rootStarted) {
        rootStarted = true;
        for (const tool of required) assert(options.tools.some(definition => definition.name === tool), `Parent missing ${tool}`);
        response = calls(Array.from({ length: 6 }, (_, index) => ['subagent', { description: `Local child ${index}`, prompt: `CHILD_FIXTURE_${index}` }]));
      } else if (options.messages.some(message => message.source?.kind === 'goal')) {
        const goal = ctx.goals.get(goalAgent);
        response = goal.phase === 'active' && goal.roundsStarted === 2
          ? calls([['update_goal', { goal_id: goal.id, revision: goal.revision, action: 'complete' }]])
          : text('Goal fixture progress');
      } else response = text('Parent received child completion');
      for (const chunk of response) yield chunk;
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureModel());
  const create = async id => (await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd: host.root, agentPreset: 'pentest' },
    agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'pentest'); } })).agent;
  parent = await create('orchestration-parent');
  assert(ctx.commands.list(parent).some(command => command.name === 'goal'));
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'ROOT_FIXTURE' }], source: { kind: 'user' } }));
  await parent.whenIdle(); await ctx.subagents.waitForChildren(parent); await parent.whenIdle();
  const children = await ctx.subagents.listChildren(parent.id);
  assert.equal(children.length, 6, 'Six real local children must start, without grandchildren');
  assert.equal(childStarts, 6);
  const invoke = async (name, args = {}) => {
    const pipeline = new ToolExecutionPipeline(ctx);
    const prepared = await pipeline.prepare({ name, arguments: args, agent: parent, callId: ToolCallId(randomUUID()), signal: AbortSignal.timeout(5000) });
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
    return pipeline.complete(prepared.exec, outcome);
  };
  assert.equal((await invoke('list_agents')).isError, false);
  assert.equal((await invoke('send_message', { agent_id: children[0].id, message: 'FOLLOWUP_FIXTURE' })).isError, false);
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle();
  assert(followups > 0, 'A completed child must accept a later message');
  assert.equal((await invoke('subagent_fork', { description: 'Fork local fixture', prompt: 'FORK_FIXTURE' })).isError, false);
  await ctx.subagents.waitForChildren(parent); await parent.whenIdle();
  assert.equal((await ctx.subagents.listChildren(parent.id)).length, 7);
  assert.equal(rawRan, false, 'Child must not bypass unadapted-tool review');
  const childEvents = [...logs].filter(([id]) => id !== parent.id).flatMap(([, events]) => events);
  for (const name of ['pentest_http', 'raw_socket', 'subagent']) {
    const ids = childEvents.filter(event => event.type === 'tool/call' && event.data.name === name).map(event => event.data.callId);
    assert(ids.length >= 6, `Missing child ${name} attempts`);
    const results = childEvents.filter(event => event.type === 'tool/result' && ids.includes(event.data.message.toolCallId));
    assert.equal(results.length, ids.length, `Every ${name} attempt must settle`);
    assert(results.every(event => event.data.message.isError), `${name} must stay guarded inside every child`);
  }
  const status = await invoke('pentest_status');
  for (const name of required) assert(status.value.availableTools.includes(name));
  assert.equal(status.value.budget.requests, 0);

  goalAgent = await create('orchestration-goal');
  const completed = new Promise(resolve => {
    ctx.on('session/event', (session, event) => {
      if (session.id === goalAgent.id && event.type === 'turn/end' && ctx.goals.get(goalAgent)?.phase === 'complete') resolve();
    });
  });
  const command = await ctx.commands.execute(goalAgent, '/goal Complete the local goal fixture', [], AbortSignal.timeout(5000));
  assert.equal(command.result.kind, 'success');
  await completed; await goalAgent.whenIdle();
  assert.equal(ctx.goals.get(goalAgent).roundsStarted, 2);
  assert.equal(ctx.goals.get(goalAgent).phase, 'complete');
  await ctx.pentest.trajectories.flush();
  console.log(JSON.stringify({ spawned: 6, forked: 1, followup: true, childPolicyEnforced: true,
    completeToolCatalog: true, goalRounds: 2, goalPhase: 'complete', targetRequests: 0 }));
} finally { await host.close(); }
