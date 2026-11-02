import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, PreparedAdapterCall, StreamChunk } from '@deepseek-ai/dsh-llm';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { id } from '@dsh-pentest/contracts';
import { PentestRuntime, ToolPolicy, InspectionTools, HttpTools, FuzzTools, ModelEgressPlugin, modelJudge, apply } from './index.ts';
import { PluginConfigSchema } from './runtime.ts';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { engagement, policyConfig, testJudge } from '../../../tests/fixtures.ts';
import { HttpBroker } from '@dsh-pentest/http';
import { ScopeService } from '@dsh-pentest/scope';
import * as ManagedGraph from './entries/graph.ts';

it('preserves model transport failures and reports empty judgment output clearly', async () => {
  for (const [chunks, message] of [
    [[{ type: 'finish', reason: { kind: 'error', failure: { message: 'Fixture provider connection refused' } } }], 'Fixture provider connection refused'],
    [[{ type: 'finish', reason: { kind: 'stop' } }], 'returned no text'],
  ] as const) {
    const ctx = { llm: { async *stream() { for (const chunk of chunks) yield chunk; } } } as unknown as Context;
    const { action } = await import('../../../tests/fixtures.ts');
    await expect(modelJudge(ctx).judge(action(), engagement().model, AbortSignal.timeout(1000))).rejects.toThrow(message);
  }
});

it('uses captured provider configuration across scope revisions without asking for model access', async () => {
  const paths: string[] = [];
  const server = http.createServer((req, res) => { paths.push(req.url!); res.end('fixture response'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const base = `http://127.0.0.1:${address.port}`;
  let endpoint = `${base}/first`;
  class FixtureAdapter extends LlmAdapter {
    override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
      const captured = endpoint;
      return { model: await this.resolveModel(provider, model), transport: { endpoints: [captured, `${base}/auxiliary`] },
        stream: () => this.request(captured) };
    }
    stream(_options: GenerateOptions): AsyncIterable<StreamChunk> { return this.request(endpoint); }
    private async *request(url: string): AsyncIterable<StreamChunk> {
      const response = await fetch(`${url}/responses`);
      const auxiliary = await fetch(`${base}/auxiliary/input`); await auxiliary.body?.cancel();
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: await response.text() };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture response' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  const ctx = new Context();
  const runtime = await PentestRuntime.open({ engagement: engagement(), policy: policyConfig,
    root: await mkdtemp(join(tmpdir(), 'djupleita-provider-')), keychainHelper: '/unused', secrets: {
      async get() { return undefined; }, async set() {}, async remove() {},
    } }, testJudge);
  const originalFetch = globalThis.fetch;
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin({ name: 'provider-runtime-fixture', apply(inner: Context) { inner.provide('pentest', runtime); } });
    await ctx.plugin(ModelEgressPlugin);
    ctx.llm.registerAdapter(['openai', 'custom'], new FixtureAdapter());
    runtime.review.connect();
    const review = vi.spyOn(runtime.review, 'request');
    const config = { provider: 'openai', model: 'configured-model' };
    const collect = async (stream: AsyncIterable<StreamChunk>) => {
      const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk);
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } });
      expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'fixture response' });
    };
    const session = id<'SessionId'>();
    for (const host of ['first.invalid', 'second.invalid']) {
      await runtime.updateSettings({ ...runtime.scope.scope, targets: [{ host, schemes: ['https'], ports: [443], pathPrefixes: ['/'], allowPrivateAddresses: false }], services: { model: [], intelligence: [], telemetry: [] } }, policyConfig, session);
      await collect(ctx.llm.stream({ ...config, messages: [], signal: AbortSignal.timeout(3000) }));
      expect(() => runtime.scope.check({ url: `${endpoint}/responses`, purpose: 'target' })).toThrow();
    }
    const prepared = await ctx.llm.prepareCall(config);
    endpoint = `${base}/second`;
    await collect(prepared.stream({ ...prepared.config, messages: [], signal: AbortSignal.timeout(3000) }));
    await collect(ctx.llm.stream({ ...config, messages: [], signal: AbortSignal.timeout(3000) }));
    await collect(ctx.llm.stream({ ...config, provider: 'custom', messages: [], signal: AbortSignal.timeout(3000) }));
    expect(paths.filter(path => path !== '/auxiliary/input')).toEqual(['/first/responses', '/first/responses', '/first/responses', '/second/responses', '/second/responses']);
    expect(paths.filter(path => path === '/auxiliary/input')).toHaveLength(5);
    expect(review).not.toHaveBeenCalled();
    expect(runtime.review.snapshot().pending).toEqual([]);
  } finally {
    await ctx.fiber.dispose(); await runtime.close();
    server.closeAllConnections(); server.close(); await once(server, 'close');
  }
  expect(globalThis.fetch).toBe(originalFetch);
});

async function harness(skipPolicy = false) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Native);
  const models: string[] = [];
  const runtime = await PentestRuntime.open({ engagement: engagement(), policy: policyConfig,
    root: await mkdtemp(join(tmpdir(), 'dsh-runtime-')), keychainHelper: '/unused', secrets: {
      async get() { return undefined; }, async set() {}, async remove() {},
    } }, { name: 'fixture', async judge(action, model, signal) {
      models.push(model.model); return testJudge.judge(action, model, signal);
    } });
  const agent = { id: SessionId(id<'SessionId'>()), model: { current: () => ({ provider: 'fixture', model: 'selected-by-user' }) } } as Agent;
  await ctx.plugin({ name: 'fixture-runtime', apply(inner: Context) { inner.provide('pentest', runtime); } });
  if (skipPolicy) ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }));
  await ctx.plugin(ToolPolicy); await ctx.plugin(InspectionTools);
  const invoke = async (name: string, args: unknown = {}) => {
    const pipeline = new ToolExecutionPipeline(ctx);
    const prepared = await pipeline.prepare({ name, arguments: args, callId: ToolCallId(id<'CallId'>()), agent, signal: AbortSignal.timeout(5000) });
    const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared;
    const result = await pipeline.complete(prepared.exec, outcome);
    await runtime.trajectories.flush();
    return result;
  };
  return { ctx, runtime, agent, invoke, models, async close() { await ctx.fiber.dispose(); await runtime.close(); } };
}

it('executes trusted status through the real DSH pipeline without model judgment and records final results', async () => {
  const h = await harness();
  try {
    const result = await h.invoke('pentest_status');
    expect(result.isError).toBe(false);
    expect(result).toMatchObject({ value: { availableTools: ['pentest_status'] } });
    expect(h.models).toEqual([]);
    const events = await h.runtime.trajectories.read(h.agent.id as unknown as import('@dsh-pentest/contracts').SessionId);
    expect(events.map(event => event.type)).toEqual(['policy/decision', 'harness/tool-result']);
    expect(JSON.stringify(events)).toContain('pentest_status');
  } finally { await h.close(); }
});

it('blocks unadapted tools before their bodies can execute', async () => {
  const h = await harness(); let ran = false;
  try {
    h.ctx.tools.register({ name: 'raw_socket', description: 'fixture', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [] }, async execute() { ran = true; return true; } });
    const result = await h.invoke('raw_socket');
    expect(result.isError).toBe(true); expect(ran).toBe(false);
    expect(result.content).toEqual(expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('trusted pentest execution adapter') })]));
  } finally { await h.close(); }
});

it('keeps repeated status calls small even when the archived trajectory contains megabyte tool results', async () => {
  const h = await harness();
  try {
    const session = h.runtime.session({ agent: h.agent } as ToolExecution);
    await h.runtime.trajectories.append(session, 'fixture/large-tool-result', { content: 'archived evidence '.repeat(100000) });
    for (let call = 0; call < 6; call++) {
      const reply = await h.invoke('pentest_status');
      expect(reply.isError).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(reply))).toBeLessThan(32000);
      expect(JSON.stringify(reply)).not.toContain('archived evidence');
    }
    const archived = await h.runtime.trajectories.read(session);
    expect(archived.some(event => event.type === 'fixture/large-tool-result' && JSON.stringify(event.data).length > 1000000)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(archived))).toBeLessThan(2000000);
  } finally { await h.close(); }
});

it('unloads managed bundle tools without removing engagement inspection or effect enforcement', async () => {
  const h = await harness();
  try {
    const fiber = await h.ctx.plugin(ManagedGraph);
    expect(h.runtime.inventory().some(tool => tool.tool === 'pentest_graph_paths')).toBe(true);
    expect((await h.invoke('pentest_graph_export')).isError).toBe(false);
    await fiber.dispose();
    expect(h.runtime.inventory().some(tool => tool.plugin === 'graph')).toBe(false);
    expect((await h.invoke('pentest_status')).isError).toBe(false);
    let ran = false;
    h.ctx.tools.register({ name: 'unadapted_after_unload', description: 'fixture', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [] }, async execute() { ran = true; return true; } });
    expect((await h.invoke('unadapted_after_unload')).isError).toBe(true);
    expect(ran).toBe(false);
  } finally { await h.close(); }
});

it('allows only one runtime writer and releases ownership after a clean close', async () => {
  const config = { engagement: engagement(), policy: policyConfig, root: await mkdtemp(join(tmpdir(), 'dsh-lock-')), keychainHelper: '/unused' };
  const first = await PentestRuntime.open(config, testJudge);
  await expect(PentestRuntime.open(config, testJudge)).rejects.toThrow('already has a writer');
  await first.close();
  const reopened = await PentestRuntime.open(config, testJudge); await reopened.close();
});

it('mirrors real DSH session events into the chat trajectory at the durability checkpoint', async () => {
  const h = await harness();
  try {
    await h.ctx.plugin(Sessions);
    const session = h.ctx.sessions.create(h.agent.id);
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Local session fixture' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    await h.ctx.sessions.flush(session);
    const events = await h.runtime.trajectories.read(h.agent.id as unknown as import('@dsh-pentest/contracts').SessionId);
    expect(events.some(event => event.type === 'harness/session-event' && JSON.stringify(event.data).includes('Local session fixture'))).toBe(true);
  } finally { await h.close(); }
});

it('does not allow another pre-execute listener to skip the monotonic pentest guard', async () => {
  const h = await harness(true);
  try {
    const result = await h.invoke('pentest_status');
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('not completed for this exact tool call');
    expect(h.models).toEqual([]);
  } finally { await h.close(); }
});

it('activates the complete parent/child plugin tree and exposes the owner-only desktop channel', async () => {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Native);
  let connection!: HostConnectionService;
  await ctx.plugin({ name: 'fixture-host', apply(inner: Context) {
    inner.provide('llm', {});
    connection = new HostConnectionService(inner, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
  } });
  try {
    const config = { engagement: engagement(), policy: policyConfig, root: await mkdtemp(join(tmpdir(), 'dsh-tree-')), keychainHelper: '/unused' };
    await ctx.plugin({ name: 'pentest-root-fixture', inject: ['tools', 'llm'], apply(inner: Context) { return apply(inner, config, { judge: testJudge }); } });
    const shared = connection.createSharedFetchHandler('/api');
    const request = (method = 'pentest/snapshot') => new Request('http://host/api/pentest/snapshot', {
      method: 'POST', body: JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload: {} }),
    });
    let response = await shared.fetch(request(), connection.browserPeer);
    for (let attempt = 0; response.status === 404 && attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      response = await shared.fetch(request(), connection.browserPeer);
    }
    expect(response.status).toBe(200);
    expect((await response.json() as { result: { ok: boolean } }).result.ok).toBe(true);
    const sessionId = id<'SessionId'>();
    const scopeInstructions = async () => (await ctx.systemPrompt.assemble()).contexts.find(item => item.name === 'djupleita-target-scope')?.text;
    expect(await scopeInstructions()).toContain('ON: target boundaries are enforced');
    expect(await scopeInstructions()).toContain('*.example.test');
    const scopeSession = id<'SessionId'>();
    await ctx.pentest.updateSettings({ ...ctx.pentest.scope.scope, enabled: false }, policyConfig, scopeSession);
    expect(await scopeInstructions()).toContain('OFF: target host, port, path and network boundaries are not enforced');
    await ctx.pentest.updateSettings({ ...ctx.pentest.scope.scope, enabled: true }, policyConfig, scopeSession);
    await ctx.pentest.trajectories.append(sessionId, 'fixture/first', { value: 1 });
    await ctx.pentest.trajectories.append(sessionId, 'fixture/second', { value: 2 });
    await ctx.pentest.trajectories.append(sessionId, 'fixture/large', { body: 'x'.repeat(20000) });
    const inspect = async (endpoint: string, payload: unknown) => {
      const request = new Request(`http://host/api/pentest/${endpoint}`, { method: 'POST', body: JSON.stringify({
        type: 'client-request', rpcId: 'test-inspect', method: `pentest/${endpoint}`, payload,
      }) });
      const response = await shared.fetch(request, connection.browserPeer);
      expect(response.status).toBe(200);
      return (await response.json() as { result: { ok: boolean; value?: unknown } }).result;
    };
    expect(await inspect('trajectory/page', { sessionId, before: 2 })).toMatchObject({ ok: true, value: { total: 3, events: [{ seq: 0 }, { seq: 1 }], nextBefore: null } });
    expect(await inspect('trajectory/detail', { sessionId, seq: 2 })).toMatchObject({ ok: true, value: { text: expect.any(String), offset: 0, nextOffset: 16384 } });
    expect(await inspect('graph/page', { offset: 0 })).toMatchObject({ ok: true, value: { nodes: [], edges: [], counts: { nodes: 0, edges: 0 } } });
    expect(await inspect('trajectory/detail', { sessionId, seq: -1 })).toMatchObject({ ok: false });
    expect(await inspect('graph/page', { offset: -1 })).toMatchObject({ ok: false });
    // The parent's owner UI can review blocked children without opening their sessions.
    const children = [id<'SessionId'>(), id<'SessionId'>(), id<'SessionId'>()];
    const waiting = children.map((child, index) => ctx.pentest.review.run({ sessionId: child, tool: 'fixture_delete',
      arguments: { index }, argumentsHash: String(index), grants: new Set() },
    () => ctx.pentest.review.request('policy', { effects: ['delete'] }, `Blocked child ${index}`, AbortSignal.timeout(5000))));
    await expect.poll(() => ctx.pentest.review.snapshot().pending.length).toBe(3);
    const inbox = await inspect('review/snapshot', { sessionId });
    expect(inbox).toMatchObject({ ok: true, value: { pending: children.map(child => ({ sessionId: child })) } });
    expect(inbox.value).not.toHaveProperty('graph'); expect(inbox.value).not.toHaveProperty('events');
    const questions = ctx.pentest.review.snapshot().pending;
    expect(await inspect('review/decide', { sessionId, requestId: questions[0]!.id, choice: 'once' })).toMatchObject({ ok: false });
    for (const [index, choice] of ['once', 'always', 'reject'].entries()) {
      expect(await inspect('review/decide', { sessionId: children[index], requestId: questions[index]!.id, choice })).toMatchObject({ ok: true });
    }
    expect(await Promise.all(waiting)).toEqual([true, true, false]);
    expect(await inspect('review/snapshot', {})).toMatchObject({ ok: true, value: { pending: [], grants: [{ tool: 'fixture_delete' }] } });
    expect(await inspect('review/decide', { sessionId: children[0], requestId: questions[0]!.id, choice: 'always' })).toMatchObject({ ok: false });
    expect((await ctx.pentest.trajectories.read(children[0]!)).some(event => event.type === 'policy/review-decided')).toBe(true);
    expect((await ctx.pentest.trajectories.read(sessionId)).some(event => event.type === 'policy/review-decided')).toBe(false);
    const other = { principal: { kind: 'api-key' } } as unknown as typeof connection.browserPeer;
    expect((await shared.fetch(request(), other)).status).toBe(403);
    for (const endpoint of ['setup/check', 'setup/install-recon', 'setup/install-ffuf', 'setup/install-rea', 'setup/load', 'trajectory/page', 'trajectory/detail', 'graph/page', 'review/snapshot', 'review/decide']) {
      const setup = new Request(`http://host/api/pentest/${endpoint}`, { method: 'POST', body: JSON.stringify({
        type: 'client-request', rpcId: 'test-setup', method: `pentest/${endpoint}`, payload: { sessionId: 'setup-test' },
      }) });
      expect((await shared.fetch(setup, other)).status).toBe(403);
    }
    expect((await shared.fetch(request('different/method'), connection.browserPeer)).status).toBe(400);
    expect(ctx.pentest.inventory().length).toBeGreaterThan(0);
  } finally { await ctx.fiber.dispose(); }
});

it('mounts ffuf as an optional bundle with a policy descriptor and removes its tools when disabled', async () => {
  const h = await harness();
  try {
    const fiber = await h.ctx.plugin(FuzzTools);
    expect(h.runtime.inventory()).toEqual(expect.arrayContaining([
      { tool: 'pentest_ffuf', plugin: 'ffuf', confinement: 'brokered' },
      { tool: 'pentest_ffuf_doctor', plugin: 'ffuf', confinement: 'local-read' },
    ]));
    const result = await h.invoke('pentest_ffuf_doctor');
    expect(result.isError).toBe(false); expect(JSON.stringify(result)).toContain('Install ffuf');
    await fiber.dispose();
    expect(h.runtime.inventory().some(row => row.plugin === 'ffuf')).toBe(false);
    expect(h.ctx.tools.get('pentest_ffuf')).toBeUndefined();
  } finally { await h.close(); }
});

it.skipIf(!process.env.DSH_TEST_FFUF || !['darwin', 'linux'].includes(process.platform))('carries a real ffuf request into the inline owner review before allowing a destructive URL', async () => {
  const h = await harness(); h.runtime.review.connect(); let requests = 0;
  const scope = new ScopeService(h.runtime.scope.scope, async () => [{ address: '93.184.216.34', family: 4 }], h.runtime.review);
  vi.spyOn(h.runtime, 'http').mockImplementation(session => new HttpBroker({ timeoutMs: 1000, maxRedirects: 2, maxRequestBytes: 1024 },
    h.runtime.engagement, scope, h.runtime.policy(session), h.runtime.identities, h.runtime.trajectories, h.runtime.evidence, h.runtime.redactor,
    async () => { requests++; return { status: 200, headers: {}, body: 'local fixture response' }; }, undefined, h.runtime.approve));
  try {
    const binary = process.env.DSH_TEST_FFUF!;
    await h.runtime.updatePlugins(PluginConfigSchema.parse({ ffuf: { binary: { path: binary,
      sha256: createHash('sha256').update(await readFile(binary)).digest('hex') }, timeoutMs: 4000 } }), h.runtime.session({ agent: h.agent } as ToolExecution));
    await h.ctx.plugin(FuzzTools);
    const blocked = h.invoke('pentest_ffuf', { url: 'https://app.example.test/FUZZ', words: ['delete'], concurrency: 1 });
    await expect.poll(() => h.runtime.review.snapshot().pending.length, { timeout: 10000 }).toBe(1);
    const question = h.runtime.review.snapshot().pending[0]!;
    expect(question.tool).toBe('pentest_ffuf'); expect(JSON.stringify(question)).toContain('/delete'); expect(requests).toBe(0);
    await h.runtime.review.decide(question.id, question.sessionId, 'once');
    const result = await blocked;
    expect(result.isError, JSON.stringify(result)).toBe(false);
    expect(JSON.stringify(result)).toContain('"completed":true'); expect(requests).toBe(1);
  } finally { await h.close(); }
});

it('resumes a blocked pipeline once, remembers exact operations and asks again for changed arguments', async () => {
  const h = await harness(); let ran = 0;
  h.runtime.review.connect();
  h.runtime.registerDescriptor('review_fixture', { plugin: 'fixture', confinement: 'local-read',
    describe: () => ({ destinations: [], effects: ['delete'], reversible: false }) });
  h.ctx.tools.register({ name: 'review_fixture', description: 'local approval fixture', parameters: { type: 'object' },
    output: { schema: { type: 'number' }, render: () => [] }, async execute() { return ++ran; } });
  const pending = async () => {
    await expect.poll(() => h.runtime.review.snapshot().pending.length).toBe(1);
    return h.runtime.review.snapshot().pending[0]!;
  };
  try {
    const first = h.invoke('review_fixture', { item: 'one' });
    const one = await pending(); expect(ran).toBe(0);
    await h.runtime.review.decide(one.id, one.sessionId, 'once'); expect((await first).isError).toBe(false); expect(ran).toBe(1);
    const second = h.invoke('review_fixture', { item: 'one' });
    const always = await pending();
    await h.runtime.review.decide(always.id, always.sessionId, 'always'); expect((await second).isError).toBe(false);
    expect((await h.invoke('review_fixture', { item: 'one' })).isError).toBe(false); expect(ran).toBe(3);
    const changed = h.invoke('review_fixture', { item: 'two' });
    const rejected = await pending(); await h.runtime.review.decide(rejected.id, rejected.sessionId, 'reject');
    expect((await changed).isError).toBe(true); expect(ran).toBe(3);
  } finally { await h.close(); }
});

it('presents an explicit policy deny to the operator and resumes only after their decision', async () => {
  const h = await harness(); h.runtime.review.connect();
  try {
    const sessionId = h.runtime.session({ agent: h.agent } as Parameters<typeof h.runtime.session>[0]);
    await h.runtime.updateSettings(h.runtime.scope.scope, { ...policyConfig, rules: [
      { id: 'review-read', tools: ['pentest_status'], effects: ['read'], decision: 'deny', reason: 'Operator review fixture' },
    ] }, sessionId);
    const blocked = h.invoke('pentest_status');
    await expect.poll(() => h.runtime.review.snapshot().pending.length).toBe(1);
    const question = h.runtime.review.snapshot().pending[0]!;
    expect(question.reason).toContain('Operator review fixture');
    await h.runtime.review.decide(question.id, question.sessionId, 'once'); expect((await blocked).isError).toBe(false);
  } finally { await h.close(); }
});

it('carries one HTTP approval through nested policy checks without executing the request twice', async () => {
  const h = await harness(); h.runtime.review.connect(); let requests = 0;
  const scope = new ScopeService(h.runtime.scope.scope, async () => [{ address: '93.184.216.34', family: 4 }], h.runtime.review);
  vi.spyOn(h.runtime, 'http').mockImplementation(session => new HttpBroker({ timeoutMs: 1000, maxRedirects: 2, maxRequestBytes: 1024 },
    h.runtime.engagement, scope, h.runtime.policy(session), h.runtime.identities, h.runtime.trajectories, h.runtime.evidence, h.runtime.redactor,
    async () => { requests++; return { status: 200, headers: {}, body: 'fixture response' }; }, undefined, h.runtime.approve));
  try {
    await h.ctx.plugin(HttpTools);
    const blocked = h.invoke('pentest_http', { url: 'https://app.example.test/object/1', method: 'DELETE' });
    await expect.poll(() => h.runtime.review.snapshot().pending.length).toBe(1);
    const question = h.runtime.review.snapshot().pending[0]!; expect(requests).toBe(0);
    await h.runtime.review.decide(question.id, question.sessionId, 'once');
    expect((await blocked).isError).toBe(false); expect(requests).toBe(1);
    expect(h.runtime.review.snapshot().pending).toHaveLength(0);
  } finally { await h.close(); }
});

it('allows research through the real tool pipeline without granting external mutations or exclusions', async () => {
  const h = await harness(); let requests = 0;
  try {
    const session = h.runtime.session({ agent: h.agent } as ToolExecution);
    await h.runtime.updateSettings({ ...h.runtime.scope.scope,
      targets: [{ host: 'target.example.test', schemes: ['https'], ports: [443], pathPrefixes: ['/'], allowPrivateAddresses: false }],
      exclusions: ['excluded.example.test'] }, policyConfig, session);
    const scopes = new ScopeService(h.runtime.scope.scope, async () => [{ address: '93.184.216.34', family: 4 }], h.runtime.review);
    vi.spyOn(h.runtime, 'http').mockImplementation(chat => new HttpBroker({ timeoutMs: 1000, maxRedirects: 2, maxRequestBytes: 1024 },
      h.runtime.engagement, scopes, h.runtime.policy(chat), h.runtime.identities, h.runtime.trajectories, h.runtime.evidence, h.runtime.redactor,
      async () => { requests++; return { status: 200, headers: {}, body: 'Synthetic CVE research' }; }, undefined, h.runtime.approve));
    await h.ctx.plugin(HttpTools);
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect((await h.invoke('pentest_http', { url: 'https://research.example.test/blog', method })).isError).toBe(false);
    }
    for (const args of [{ url: 'https://research.example.test/blog', method: 'POST' },
      { url: 'https://research.example.test/items?action=delete', method: 'GET' },
      { url: 'https://excluded.example.test/blog', method: 'GET' }]) {
      expect((await h.invoke('pentest_http', args)).isError).toBe(true);
    }
    expect(requests).toBe(3);
    expect(h.runtime.review.snapshot().pending).toHaveLength(0);
  } finally { await h.close(); }
});
