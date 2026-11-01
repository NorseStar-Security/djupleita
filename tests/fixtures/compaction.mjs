/** Keyless acceptance: load the real shipped preset, then resume a bloated chat. */
import assert from 'node:assert/strict';
import { load, presetHost } from './preset-host.mjs';
const { Session, SessionId } = await load('packages/core/session');
const { LlmAdapter, ToolCallId, createMessage, createToolResultMessage, createUserMessage } = await load('packages/llm/llm');
const host = await presetHost(), { ctx } = host;
try {
  assert.deepEqual(await ctx.agentPresets.resolve(), { id: 'pentest' });

  const requests = [];
  class FixtureAdapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, context: { contextWindow: 128000 } };
    }
    async *stream(options) {
      requests.push(options);
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Continued after automatic pruning.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
  const session = Session.create(SessionId('bloated-history-seed'));
  const callId = ToolCallId('large-status');
  const original = 'archived result '.repeat(600000);
  session.append('turn/start', { turn: 1 });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Inspect status' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('request/header', { header: { config: { provider: 'fixture', model: 'configured-model' } }, reason: 'initial' });
  session.append('assistant/message', { stream: [], turn: 1, step: 1, message: createMessage({
    role: 'assistant', content: [{ type: 'tool-call', id: callId, name: 'pentest_status', arguments: '{}' }],
    source: { kind: 'model', provider: 'fixture', model: 'configured-model' },
  }) }, { surfaceOp: 'append' });
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'pentest_status', arguments: '{}' });
  session.append('tool/result', { turn: 1, step: 1, message: createToolResultMessage({
    callId, content: [{ type: 'text', text: original }], isError: false,
  }) }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1 });
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('compaction-acceptance'), seed: session.snapshotEvents(),
    agentOptions: { provider: 'fixture', model: 'configured-model' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx); },
  });
  assert(ctx.agentPresets.serviceFor(agent, 'compaction').config.auto);
  assert(ctx.agentPresets.serviceFor(agent, 'toolResultPruner'));
  assert(ctx.commands.list(agent).some(command => command.name === 'compact'));
  assert.equal(ctx.get('compaction'), undefined, 'Preset services must remain isolated from the host');
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Continue' }], source: { kind: 'user' } }));
  await agent.whenIdle();
  assert.equal(requests.length, 1, 'Pruning alone should clear pressure without a summary request');
  assert(Buffer.byteLength(JSON.stringify(requests[0].messages)) < 32000, 'First resumed model request must already be small');
  const events = agent.session.snapshotEvents();
  assert(events.some(event => event.type === 'tool/result' && event.data.message.content.some(block => block.text === original)), 'Original evidence must remain in the durable log');
  assert(agent.session.surface.replaceGeneration > 0, 'Automatic pressure must replace the model-facing tool result');
  assert.deepEqual(events.at(-1).data.reason, { kind: 'completed' });
  console.log(JSON.stringify({ preset: 'pentest', manualCompact: true, originalBytes: Buffer.byteLength(original),
    resumedRequestBytes: Buffer.byteLength(JSON.stringify(requests[0].messages)), modelRequests: requests.length }));
} finally { await host.close(); }
