import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import Tools from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline';
import * as Native from '@deepseek-ai/dsh-tool-executor-native';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection';
import { id } from '@dsh-pentest/contracts';
import * as Mode from './mode.ts';
import { HttpTools } from './index.ts';
import { engagement, policyConfig } from '../../../tests/fixtures.ts';

it('unloads the complete engagement layer, keeps owner controls, and restores saved scope and optional tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-mode-'));
  const config = { root, engagement: engagement(), policy: policyConfig, keychainHelper: '/unused' };
  const ctx = new Context();
  let connection!: HostConnectionService;
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Native);
    await ctx.plugin({ name: 'mode-fixture-host', apply(inner: Context) {
      inner.provide('llm', {});
      connection = new HostConnectionService(inner, [], {} as ConstructorParameters<typeof HostConnectionService>[2]);
    } });
    const mode = await ctx.plugin(Mode, config);
    await ctx.plugin(HttpTools);
    expect(ctx.pentestMode.enabled).toBe(true);
    expect(ctx.tools.get('pentest_http')).toBeDefined();
    expect(JSON.stringify(await ctx.systemPrompt.assemble())).toContain('authorized penetration testing assistant');
    const original = ctx.pentest;
    const scope = { ...original.scope.scope, enabled: false, exclusions: ['saved.example.test'] };
    await original.updateSettings(scope, policyConfig, id<'SessionId'>());
    const revoked = original.signal(new AbortController().signal);
    await ctx.pentestMode.setEnabled(false);
    expect(revoked.aborted).toBe(true);
    expect(ctx.get('pentest')).toBeUndefined();
    expect(ctx.tools.get('pentest_http')).toBeUndefined();
    expect(ctx.tools.get('pentest_status')).toBeUndefined();
    const offPrompt = await ctx.systemPrompt.assemble();
    expect(offPrompt.contexts.filter(context => context.name.startsWith('djupleita-')).map(context => context.name)).toEqual(['djupleita-mode']);
    expect(JSON.stringify(offPrompt)).toContain('engagement layer is OFF');

    // The native pipeline no longer requires a pentest effect adapter.
    let calls = 0;
    ctx.tools.register({ name: 'fixture_local_change', description: 'Local fixture operation', parameters: { type: 'object' },
      output: { schema: { type: 'number' }, render: () => [] }, async execute() { return ++calls; } });
    const agent = { id: SessionId('mode-fixture'), model: { current: () => ({ provider: 'fixture', model: 'fixture' }) } } as Agent;
    const pipeline = new ToolExecutionPipeline(ctx);
    const prepared = await pipeline.prepare({ name: 'fixture_local_change', arguments: {}, callId: ToolCallId('mode-off'), agent, signal: AbortSignal.timeout(5000) });
    expect(prepared.kind).toBe('dispatch');
    const result = await pipeline.complete(prepared.exec, prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared);
    expect(result.isError).toBe(false); expect(calls).toBe(1);

    const shared = connection.createSharedFetchHandler('/api');
    const request = (endpoint: string, payload = {}) => new Request(`http://host/api/djupleita/${endpoint}`, { method: 'POST',
      body: JSON.stringify({ type: 'client-request', rpcId: 'mode', method: `djupleita/${endpoint}`, payload }) });
    const other = { principal: { kind: 'api-key' } } as unknown as typeof connection.browserPeer;
    expect((await shared.fetch(request('mode'), other)).status).toBe(403);
    expect((await shared.fetch(request('mode/update', { enabled: true }), other)).status).toBe(403);
    const off = await shared.fetch(request('mode'), connection.browserPeer);
    expect(await off.json()).toMatchObject({ result: { ok: true, value: { enabled: false } } });

    await mode.dispose();
    await ctx.plugin(Mode, config);
    expect(ctx.pentestMode.enabled).toBe(false);
    expect(ctx.get('pentest')).toBeUndefined();
    const enabled = await shared.fetch(request('mode/update', { enabled: true }), connection.browserPeer);
    expect(await enabled.json()).toMatchObject({ result: { ok: true, value: { enabled: true } } });
    await expect.poll(() => ctx.tools.get('pentest_http') !== undefined).toBe(true);
    expect(ctx.pentest.scope.scope).toEqual(scope);
    expect(ctx.pentest).not.toBe(original);
    expect(JSON.parse(await readFile(join(root, config.engagement.id, 'mode.json'), 'utf8'))).toEqual({ enabled: true });
  } finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
});
