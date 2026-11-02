/** Owner-controlled lifetime of the complete engagement layer. */
import type { Context, Fiber } from '@deepseek-ai/cordis';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { EngagementSchema } from '@dsh-pentest/contracts';
import type { RuntimeConfig } from './runtime.ts';
import { applyCore } from './index.ts';

const ModeSchema = z.object({ enabled: z.boolean() }).strict();
export interface EngagementMode {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): Promise<void>;
}
declare module '@deepseek-ai/cordis' { interface Context { pentestMode: EngagementMode } }

export const name = 'djupleita-engagement-mode';
export const inject = ['tools', 'llm'];
export async function apply(ctx: Context, config: RuntimeConfig): Promise<void> {
  EngagementSchema.parse(config.engagement);
  const root = resolve(config.root, config.engagement.id), path = join(root, 'mode.json');
  await mkdir(root, { recursive: true, mode: 0o700 });
  let enabled = true;
  try { enabled = ModeSchema.parse(JSON.parse(await readFile(path, 'utf8'))).enabled; }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  let child: Fiber | undefined, queue = Promise.resolve(), closing = false;
  const activate = async (): Promise<void> => {
    const pending = ctx.plugin({ name: 'djupleita-active-engagement', apply: (inner: Context) => applyCore(inner, config) });
    try { await pending; child = pending; }
    catch (error) { await pending.dispose(); throw error; }
  };
  const deactivate = async (): Promise<void> => {
    await child?.dispose(); child = undefined;
  };
  if (enabled) await activate();
  const mode: EngagementMode = {
    get enabled() { return child !== undefined; },
    setEnabled(next) {
      const operation = queue.then(async () => {
        if (closing) throw new Error('Engagement controls are closing');
        if (next === mode.enabled) return;
        const previous = mode.enabled;
        if (next) await activate(); else await deactivate();
        try {
          const temporary = `${path}.${randomUUID()}.tmp`;
          await writeFile(temporary, `${JSON.stringify({ enabled: next })}\n`, { mode: 0o600 });
          await rename(temporary, path);
        } catch (error) {
          if (previous) await activate(); else await deactivate();
          throw error;
        }
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
  ctx.provide('pentestMode', mode);
  ctx.inject(['systemPrompt'], inner => {
    inner.systemPrompt.context({ name: 'djupleita-mode', order: 770, required: true, interpolate: false,
      text: () => mode.enabled ? '' : 'The Djupleita engagement layer is OFF. Use the ordinary DSH tools and permissions. Earlier pentest instructions, engagement scope, action review and budgets are inactive. Pentest tools are unavailable; do not call pentest_status. Only the operator can turn the engagement layer back on in Plugins.' });
  });
  ctx.effect(() => async () => { closing = true; await queue; await deactivate(); }, 'djupleita: engagement lifetime');
  ctx.inject(['connection'], inner => {
    const connection = inner.get('connection') as unknown as HostConnectionHandle;
    for (const endpoint of ['mode', 'mode/update']) connection.fetch.register({
      path: `/api/djupleita/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
        const parsed = clientRequestSchema.safeParse(await request.json().catch(() => undefined));
        if (!parsed.success || parsed.data.method !== `djupleita/${endpoint}`) return new Response('Invalid engagement control request', { status: 400 });
        const { payload, rpcId } = parsed.data;
        try {
          if (endpoint === 'mode/update') await mode.setEnabled(ModeSchema.parse(payload).enabled);
          return Response.json({ type: 'server-response', rpcId, result: { ok: true, value: { enabled: mode.enabled } } });
        } catch {
          return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { message: 'Could not change engagement mode. Refresh to check the current mode.' } } });
        }
      },
    });
  });
}
