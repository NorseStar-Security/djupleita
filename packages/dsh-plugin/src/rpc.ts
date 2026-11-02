/** Authenticated owner-only desktop inspection channel, carried by DSH Connection. */
import type { Context } from '@deepseek-ai/cordis';
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { z } from 'zod';
import { IdentitySchema } from '@dsh-pentest/identities';
import type { Identity } from '@dsh-pentest/identities';
import type { SessionId } from '@dsh-pentest/contracts';
import { ScopeSchema } from '@dsh-pentest/contracts';
import { PolicyConfigSchema } from '@dsh-pentest/policy';
import { PluginConfigSchema } from './runtime.ts';
import type {} from './index.ts';
import { assessmentEndpoints, assessmentRequest } from './assessment-rpc.ts';

const SessionSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const RequestSchema = z.object({ sessionId: SessionSchema.optional() });
const IdentityInput = z.object({ metadata: IdentitySchema.omit({ id: true }), secret: z.string().min(1).max(4 * 1024 * 1024) });
const SettingsInput = z.object({ scope: ScopeSchema, policy: PolicyConfigSchema, sessionId: SessionSchema });
export const DesktopChannel = {
  name: 'pentest-desktop-channel', inject: ['connection', 'pentest'],
  apply(ctx: Context): void {
    const connection = ctx.get('connection') as unknown as HostConnectionHandle;
    ctx.effect(() => ctx.pentest.review.connect(), 'pentest: interactive owner review');
    // Exact Connection Fetch routes require an authenticated owner Peer before
    // dispatch. Keep this surface outside the shared model-facing API gateway.
    for (const endpoint of [...assessmentEndpoints, 'snapshot', 'trajectory/page', 'trajectory/detail', 'graph/page', 'identity/create', 'settings/update', 'plugins/update', 'setup/check', 'setup/dismiss', 'setup/show', 'setup/install-recon', 'setup/install-ffuf', 'setup/install-rea', 'setup/load', 'learning/run', 'learning/promote', 'review/snapshot', 'review/decide', 'review/revoke', 'review/destination']) connection.fetch.register({
      path: `/api/pentest/${endpoint}`, methods: ['POST'], requestBody: 'buffered',
      async fetch(request) {
      const parsed = clientRequestSchema.safeParse(await request.json().catch(() => undefined));
      if (!parsed.success || parsed.data.method !== `pentest/${endpoint}`) return new Response('Invalid pentest request', { status: 400 });
      const { payload, rpcId } = parsed.data, signal = request.signal;
      const reply = (value: unknown): Response => Response.json({ type: 'server-response', rpcId, result: { ok: true, value } });
      try {
        signal.throwIfAborted();
        if (endpoint.startsWith('assessment/')) return reply(await assessmentRequest(ctx.pentest, endpoint, payload));
        if (endpoint === 'review/snapshot') {
          return reply(ctx.pentest.redactor.json({ ...ctx.pentest.review.snapshot(), setup: { ...await ctx.pentest.toolSetup() } }));
        }
        if (endpoint === 'snapshot') {
          const input = RequestSchema.parse(payload);
          return reply(await ctx.pentest.snapshot(input.sessionId as SessionId | undefined));
        }
        if (endpoint === 'trajectory/page') {
          const input = z.object({ sessionId: SessionSchema, before: z.number().int().min(0).optional() }).parse(payload);
          return reply(ctx.pentest.redactor.json(await ctx.pentest.trajectories.page(input.sessionId as SessionId, input.before)));
        }
        if (endpoint === 'trajectory/detail') {
          const input = z.object({ sessionId: SessionSchema, seq: z.number().int().min(0), offset: z.number().int().min(0).default(0) }).parse(payload);
          return reply(ctx.pentest.redactor.json(await ctx.pentest.trajectories.detail(input.sessionId as SessionId, input.seq, input.offset)));
        }
        if (endpoint === 'graph/page') {
          const input = z.object({ offset: z.number().int().min(0).default(0) }).parse(payload);
          return reply(ctx.pentest.graphPage(input.offset));
        }
        if (endpoint.startsWith('setup/')) {
          const input = z.object({ sessionId: SessionSchema }).parse(payload);
          if (endpoint === 'setup/check') return reply(await ctx.pentest.toolSetup(true));
          if (endpoint === 'setup/dismiss' || endpoint === 'setup/show') await ctx.pentest.dismissSetupBanner(endpoint === 'setup/dismiss', input.sessionId as SessionId);
          if (endpoint === 'setup/install-recon') await ctx.pentest.installRecon(input.sessionId as SessionId, signal);
          if (endpoint === 'setup/install-ffuf') await ctx.pentest.installFfuf(input.sessionId as SessionId, signal);
          if (endpoint === 'setup/install-rea') await ctx.pentest.installRea(input.sessionId as SessionId, signal);
          if (endpoint === 'setup/load') await ctx.pentest.loadLocalSetup(input.sessionId as SessionId);
          return reply({ applied: true });
        }
        if (endpoint === 'review/decide') {
          const input = z.object({ requestId: z.string().uuid(), sessionId: SessionSchema, choice: z.enum(['once', 'always', 'destination', 'reject']) }).parse(payload);
          await ctx.pentest.review.decide(input.requestId, input.sessionId as SessionId, input.choice);
          return reply({ decided: true });
        }
        if (endpoint === 'review/revoke') {
          const input = z.object({ grantId: z.string().uuid(), sessionId: SessionSchema }).parse(payload);
          await ctx.pentest.review.revoke(input.grantId, input.sessionId as SessionId);
          return reply({ revoked: true });
        }
        if (endpoint === 'review/destination') {
          const input = z.object({ host: z.string().min(1).max(253), sessionId: SessionSchema }).parse(payload);
          await ctx.pentest.review.addDestination(input.host, input.sessionId as SessionId);
          return reply({ saved: true });
        }
        if (endpoint === 'identity/create') {
          const input = IdentityInput.parse(payload);
          const identity = await ctx.pentest.createIdentity(input.metadata as Omit<Identity, 'id'>, input.secret, signal);
          return reply(identity);
        }
        if (endpoint === 'settings/update') {
          const input = SettingsInput.parse(payload);
          await ctx.pentest.updateSettings(input.scope, input.policy, input.sessionId as SessionId);
          return reply({ saved: true });
        }
        if (endpoint === 'plugins/update') {
          const input = z.object({ config: PluginConfigSchema, sessionId: SessionSchema }).parse(payload);
          await ctx.pentest.updatePlugins(input.config, input.sessionId as SessionId); return reply({ saved: true });
        }
        if (endpoint === 'learning/run') {
          const input = z.object({ datasetId: z.string(), trials: z.number().int().min(2).max(1000), sessionId: SessionSchema }).parse(payload);
          return reply(await ctx.pentest.learning().run(input.datasetId, input.trials, input.sessionId as SessionId, ctx.pentest.signal(signal)));
        }
        if (endpoint === 'learning/promote') {
          const input = z.object({ runId: z.string().uuid(), sessionId: SessionSchema }).parse(payload);
          await ctx.pentest.promoteStudy(input.runId, input.sessionId as SessionId); return reply({ promoted: true });
        }
        return new Response('Unknown engagement operation', { status: 404 });
      } catch (error) {
        return Response.json({ type: 'server-response', rpcId, result: { ok: false, error: { code: 'pentest/rejected', message: ctx.pentest.redactor.text(error instanceof Error ? error.message : 'Engagement operation failed'), details: {} } } });
      }
    } });
  },
};
