/** Optional assessment and proof tools; owner assertions/review stay in authenticated desktop RPC. */
import type { Context } from '@deepseek-ai/cordis';
import { z } from 'zod';
import { canonical, PentestError } from '@dsh-pentest/contracts';
import type { Json } from '@dsh-pentest/contracts';
import { PlanSchema, LeadSchema } from '@dsh-pentest/assessment';
import type {} from './index.ts';

const runId = z.string().uuid();
const schema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('plan'), plan: PlanSchema }),
  z.object({ operation: z.literal('join'), runId }),
  z.object({ operation: z.literal('inspect'), runId, section: z.enum(['summary', 'cells', 'leads', 'findings']).default('summary'), offset: z.number().int().min(0).default(0) }),
  z.object({ operation: z.literal('compare'), runId, baselineId: runId }),
  z.object({ operation: z.literal('readiness'), runId }),
  z.object({ operation: z.literal('cover'), runId, cellId: z.string(), status: z.enum(['tested', 'blocked']), reason: z.string().min(1).max(2000), evidenceIds: z.array(z.string().uuid()).max(20) }),
  z.object({ operation: z.literal('lead'), runId, lead: LeadSchema }),
  z.object({ operation: z.literal('stop'), runId, outcome: z.enum(['pause', 'fail', 'complete']), reason: z.string().min(1).max(2000) }),
]);
const output = { schema: { type: 'object', properties: {}, additionalProperties: true } as const,
  render: (_: unknown, value: Json) => [{ type: 'text' as const, text: canonical(value) }] };
export const AssessmentTools = {
  name: 'pentest-assessment', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    ctx.effect(() => ctx.pentest.registerDescriptor('pentest_assessment', { plugin: 'assessment', confinement: 'brokered',
      describe: () => ({ destinations: [], effects: ['read'], reversible: true }) }), 'pentest: assessment effects');
    ctx.tools.register({ name: 'pentest_assessment', description: 'Plan and resume bounded assessments with durable coverage and leads. Inspect pages of 50 items. Readiness uses owner-installed contracts. Never mark infrastructure failures as negative security tests. Only the owner can waive cells, change assertions or resume stopped work.',
      parameters: z.toJSONSchema(schema), output, async execute(args, exec) {
        const input = schema.parse(args), runtime = ctx.pentest, service = runtime.assessment, session = runtime.session(exec);
        if (input.operation === 'plan') {
          if (input.plan.maxRequests > runtime.engagement.snapshot().remainingRequests) throw new PentestError('ASSESSMENT_BUDGET', 'Run limit exceeds remaining engagement requests');
          const run = service.create(input.plan, session); return runtime.redactor.json({ runId: run.id, scorecard: service.scorecard(run.id), next: 'Owner: configure readiness and assertions in Pentest → Assessment' });
        }
        if (input.operation === 'join') return runtime.redactor.json({ runId: service.join(input.runId, session).id });
        const run = service.get(input.runId);
        if (['readiness', 'cover', 'lead', 'stop'].includes(input.operation) && !run.sessions.includes(session))
          throw new PentestError('ASSESSMENT_SESSION', 'Join this run before changing it');
        switch (input.operation) {
          case 'inspect': {
            if (input.section === 'summary') return service.scorecard(run.id);
            const items = run[input.section]; return runtime.redactor.json({ section: input.section, total: items.length,
              items: items.slice(input.offset, input.offset + 50), nextOffset: input.offset + 50 < items.length ? input.offset + 50 : null });
          }
          case 'compare': return service.compare(run.id, input.baselineId);
          case 'readiness': await service.readiness(run.id, session, exec.signal); break;
          case 'cover': await service.cover(run.id, input.cellId, input.status, input.reason, input.evidenceIds); break;
          case 'lead': service.lead(run.id, input.lead); break;
          case 'stop': service.control(run.id, input.outcome, input.reason); break;
        }
        return service.scorecard(run.id);
      } });
  },
};
export const ValidationTools = {
  name: 'pentest-validation', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    ctx.effect(() => ctx.pentest.registerDescriptor('pentest_validate', { plugin: 'validation', confinement: 'brokered',
      describe: () => ({ destinations: [], effects: ['read'], reversible: true }) }), 'pentest: validation effects');
    ctx.tools.register({ name: 'pentest_validate', description: 'Replay a trusted owner-installed read-only object authorization assertion. Runs owner baseline, other identity and negative control through the normal HTTP broker. The deterministic gate returns verified, rejected or inconclusive. Independent owner review is required before a finding enters a report.',
      parameters: z.toJSONSchema(z.object({ runId, assertionId: z.string() })), output, async execute(args, exec) {
        const input = z.object({ runId, assertionId: z.string() }).parse(args);
        return ctx.pentest.redactor.json(await ctx.pentest.assessment.validate(input.runId, input.assertionId, ctx.pentest.session(exec), exec.signal));
      } });
  },
};
