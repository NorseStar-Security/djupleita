/** Keyless replay through the shipped preset, native fork operation and Djupleita's actual run handoff. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { load, presetHost } from './preset-host.mjs';
import { applyCore } from '../../packages/dsh-plugin/lib/index.js';
import { ApiSessionAgentController } from '../../vendor/deepseek-harness/packages/api/session-controller/src/agent.ts';
import { SessionCommandController } from '../../vendor/deepseek-harness/packages/api/session-controller/src/commands.ts';
import { engagement, policyConfig, testJudge } from '../fixtures.ts';

const { LlmAdapter, createUserMessage } = await load('packages/llm/llm');
const { SessionId } = await load('packages/core/session');
const host = await presetHost(), { ctx } = host;
const inputs = [];
try {
  await applyCore(ctx, { root: join(host.root, 'engagements'), keychainHelper: '/unused',
    engagement: engagement({ model: { provider: 'fixture', model: 'fixture' } }), policy: policyConfig }, { judge: testJudge });
  ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] });
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'fixture' }) });
  ctx.provide('attachments', { admitPromptContent: async content => content });
  class FixtureModel extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 128000 } }; }
    async *stream(options) {
      inputs.push(options.messages);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Local fixture answer' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureModel());
  const source = (await ctx.agents.create({ sessionId: SessionId('replay-source'), meta: { cwd: host.root, agentPreset: 'pentest' },
    agentOptions: { provider: 'fixture', model: 'fixture' }, setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'pentest'); } })).agent;
  const run = ctx.pentest.assessment.create({ title: 'Replay fixture', maxRequests: 12,
    cells: [{ surface: 'https://app.example.test/objects/1', method: 'GET', input: 'object', family: 'authorization' }] }, source.id);
  ctx.pentest.assessment.lead(run.id, { key: 'retained', summary: 'Object access still needs a control', reason: 'needs-owner-assertion' });
  source.followup(createUserMessage({ content: [{ type: 'text', text: 'ORIGINAL_REQUEST' }], source: { kind: 'user' } }));
  await source.whenIdle();
  const events = source.session.snapshotEvents(), original = JSON.stringify(events);
  const selected = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user');
  let membershipAtAdmission = false;
  const stopMembership = ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.agent.id !== source.id) membershipAtAdmission = ctx.pentest.assessment.current(payload.agent.id)?.id === run.id;
    return next();
  });
  const commands = new SessionCommandController(ctx, new ApiSessionAgentController(ctx), host.root);
  const { sessionId } = await commands.fork({ sessionId: source.id, replay: { messageSeq: selected.seq, text: 'REVISED_REQUEST' } });
  const child = ctx.agents.get(sessionId); await child.whenIdle();
  assert(membershipAtAdmission, 'The branch must join its original run before the model starts');
  assert.equal(ctx.pentest.assessment.current(sessionId).leads[0].key, 'retained');
  assert.equal(ctx.pentest.assessment.forkLineage(sessionId).sourceId, source.id);
  assert.equal(JSON.stringify(source.session.snapshotEvents()), original);
  const replay = JSON.stringify(inputs.at(-1));
  assert(replay.includes('REVISED_REQUEST')); assert(!replay.includes('ORIGINAL_REQUEST')); assert(!replay.includes('Local fixture answer'));
  stopMembership();
  const fresh = await commands.fork({ sessionId: source.id, replay: { messageSeq: selected.seq, text: 'FRESH_REQUEST', history: 'fresh' } });
  await ctx.agents.get(fresh.sessionId).whenIdle();
  assert.equal(ctx.pentest.assessment.current(fresh.sessionId), undefined, 'Fresh replay must not inherit assessment-run context');
  assert.equal(ctx.pentest.assessment.forkLineage(fresh.sessionId).replayHistory, 'fresh');
  const ordinary = await commands.fork({ sessionId: source.id });
  assert.equal(ctx.pentest.assessment.current(ordinary.sessionId).id, run.id);
  const paused = ctx.pentest.assessment.control(run.id, 'pause', 'Pause branches together');
  assert.equal(ctx.pentest.assessment.signal(sessionId).aborted, true);
  const lineage = ctx.pentest.assessment.forkLineage(sessionId);
  await ctx.pentest.trajectories.flush();
  const trajectory = await ctx.pentest.trajectories.page(sessionId);
  assert(JSON.stringify(trajectory).includes('harness/fork'));
  console.log(JSON.stringify({ replayed: true, sourceUnchanged: true, membershipAtAdmission, ordinaryForkJoined: true,
    retainedLeads: paused.leads.length, sourceRecorded: lineage.sourceId === source.id, targetRequests: ctx.pentest.engagement.snapshot().requests }));
} finally { await host.close(); }
