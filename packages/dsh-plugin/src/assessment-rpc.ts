import { z } from 'zod';
import { PlanSchema, ReadinessSchema, AssertionSchema } from '@dsh-pentest/assessment';
import type { SessionId } from '@dsh-pentest/contracts';
import type { PentestRuntime } from './runtime.ts';

export const assessmentEndpoints = ['assessment/list', 'assessment/get', 'assessment/plan', 'assessment/configure', 'assessment/control',
  'assessment/waive', 'assessment/review', 'assessment/evidence', 'assessment/report'] as const;
const runId = z.string().uuid();
/** Called exclusively by authenticated owner Connection routes, never registered as model tools. */
export async function assessmentRequest(runtime: PentestRuntime, endpoint: string, payload: unknown): Promise<unknown> {
  const service = runtime.assessment;
  if (endpoint === 'assessment/list') {
    const { offset } = z.object({ offset: z.number().int().min(0).default(0) }).parse(payload);
    const runs = service.runs(); return runtime.redactor.json({ runs: runs.slice(offset, offset + 50).map(run => ({ id: run.id, title: run.title, state: run.state, updatedAt: run.updatedAt })),
      nextOffset: offset + 50 < runs.length ? offset + 50 : null });
  }
  if (endpoint === 'assessment/plan') {
    const input = z.object({ sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), plan: PlanSchema }).parse(payload);
    return runtime.redactor.json(service.create(input.plan, input.sessionId as SessionId));
  }
  if (endpoint === 'assessment/get') {
    const input = z.object({ runId }).parse(payload);
    return runtime.redactor.json({ run: service.get(input.runId), scorecard: service.scorecard(input.runId) });
  }
  if (endpoint === 'assessment/configure') {
    const input = z.object({ runId, readiness: ReadinessSchema, assertions: z.array(AssertionSchema).max(100) }).parse(payload);
    return runtime.redactor.json(service.configure(input.runId, input.readiness, input.assertions));
  }
  if (endpoint === 'assessment/control') {
    const input = z.object({ runId, operation: z.enum(['pause', 'resume', 'cancel', 'fail', 'complete']), reason: z.string().min(1).max(2000) }).parse(payload);
    return runtime.redactor.json(service.control(input.runId, input.operation, input.reason));
  }
  if (endpoint === 'assessment/waive') {
    const input = z.object({ runId, cellId: z.string(), reason: z.string().min(1).max(2000) }).parse(payload);
    return runtime.redactor.json(service.waive(input.runId, input.cellId, input.reason));
  }
  if (endpoint === 'assessment/review') {
    const input = z.object({ runId, findingId: z.string().uuid(), accept: z.boolean(), reason: z.string().min(1).max(2000) }).parse(payload);
    return runtime.redactor.json(service.reviewFinding(input.runId, input.findingId, input.accept, input.reason));
  }
  if (endpoint === 'assessment/evidence') {
    const input = z.object({ runId, evidenceId: z.string().uuid(), offset: z.number().int().min(0).default(0) }).parse(payload);
    return service.proofEvidence(input.runId, input.evidenceId, input.offset);
  }
  if (endpoint === 'assessment/report') {
    const input = z.object({ runId }).parse(payload); return service.report(input.runId);
  }
  throw new Error('Unknown assessment operation');
}
