import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, realpath, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { LearningService, ProcedureStudySchema, studyReceipt } from '../packages/learning/src/index.ts';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
const fixture = async () => JSON.parse(await readFile(resolve('configs/datasets/shop-authz-procedure.json'), 'utf8'));
async function service(root: string, model?: ConstructorParameters<typeof LearningService>[4]) {
  const redactor = new Redactor(), store = new TrajectoryStore(join(root, 'events'), id<'EngagementId'>(), redactor);
  const selection = vi.fn(() => ({ provider: 'fixture', model: 'deterministic' }));
  return { store, selection, learning: new LearningService({ python: process.env.DSH_TEST_OPTUNA_PYTHON ?? '/unused', script: resolve('packages/learning/python/optimize.py'), gepaScript: resolve('packages/learning/python/gepa_optimize.py'), datasets: root }, join(root, 'runs'), store, redactor, model, selection) };
}
it('rejects application leakage, backend mismatch and missing model before any evaluation', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'djupleita-gepa-'))), data = await fixture(), session = id<'SessionId'>();
  data.rows[4].appId = data.rows[0].appId;
  await writeFile(join(root, 'cases.json'), JSON.stringify(data));
  const { learning } = await service(root);
  await expect(learning.run('cases', 24, session, new AbortController().signal, 'gepa')).rejects.toThrow('cross dataset splits');
  await writeFile(join(root, 'cases.json'), JSON.stringify(await fixture()));
  await expect(learning.run('cases', 24, session, new AbortController().signal)).rejects.toThrow('matching this dataset');
  await expect(learning.run('cases', 24, session, new AbortController().signal, 'gepa')).rejects.toThrow('select a chat model');
});
it.skipIf(!process.env.DSH_TEST_OPTUNA_PYTHON)('runs real confined GEPA with brokered models, sealed test cases, evidence feedback and explicit promotion', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'djupleita-gepa-'))), data = await fixture(), session = id<'SessionId'>();
  await writeFile(join(root, 'cases.json'), JSON.stringify(data));
  const calls: { purpose: string; prompt: string }[] = [];
  const improved = 'Compare equivalent-role accounts against an established object ownership baseline. Inspect returned object data and cite all observations. Return inconclusive when the owner baseline is unavailable.';
  const { learning, store, selection } = await service(root, async (_session, request, _signal, route) => {
    expect(route).toEqual({ provider: 'fixture', model: 'deterministic' });
    calls.push(request);
    if (request.purpose === 'reflection') {
      expect(request.prompt).toContain('missing evidence');
      expect(request.prompt).not.toContain('validation-'); expect(request.prompt).not.toContain('test-');
      return '```\n' + improved + '\n```';
    }
    expect(request.prompt).not.toContain('requiredEvidence'); expect(request.prompt).not.toContain('expected');
    const input = JSON.parse(request.prompt), observations = JSON.parse(input.observations).observations;
    const [role, owner, peer] = observations, tuned = input.procedure === improved;
    const verdict = tuned ? owner.status !== 200 ? 'inconclusive' : peer.body.owner === owner.body.owner ? 'vulnerable' : 'safe' : peer.status === 200 ? 'vulnerable' : 'safe';
    return JSON.stringify({ verdict, evidence: tuned ? [role.id, owner.id, peer.id] : [peer.id], reason: 'Fixture comparison' });
  });
  const report = ProcedureStudySchema.parse(await learning.run('cases', 24, session, AbortSignal.timeout(60000), 'gepa'));
  const receipt = studyReceipt(report);
  expect(receipt).not.toHaveProperty('evaluations'); expect(receipt).not.toHaveProperty('candidates');
  expect(JSON.stringify(receipt).length).toBeLessThan(3000);
  expect(selection).toHaveBeenCalledTimes(1); expect(report.engine).toBe('gepa/0.1.4'); expect(report.candidates.length).toBeGreaterThan(1);
  expect(report.scores.test).toEqual({ baseline: 0, candidate: 1 }); expect(report.scores.validation.candidate).toBe(1);
  expect(report.budget.modelCalls).toBe(calls.length); expect(calls.length).toBeLessThanOrEqual(report.budget.maxModelCalls);
  expect(report.budget.searchEvaluations).toBeLessThanOrEqual(24);
  const firstTest = calls.findIndex(call => call.prompt.includes('test-'));
  expect(calls.slice(firstTest).some(call => call.purpose === 'reflection')).toBe(false);
  expect((await learning.promotion(report.runId, session))).toEqual({ runId: report.runId, datasetHash: report.datasetHash, text: improved });
  const events = await store.read(session); expect(events.filter(event => event.type === 'learning/model-result')).toHaveLength(calls.length);
  expect((await learning.studies()) as object).toMatchObject({ active: false, progress: null });
  expect(await readdir(join(root, 'runs', report.runId))).toContain('report.json');
  const longOutput = 'Synthetic saved output '.repeat(100);
  report.evaluations.baseline[0]!.output = longOutput;
  await writeFile(join(root, 'runs', report.runId, 'report.json'), JSON.stringify(report));
  const summary = await learning.studies();
  const preview = ProcedureStudySchema.parse(summary.reports[0]);
  expect(preview.evaluations.baseline[0]!.output).toContain('Preview shortened');
  expect(preview.evaluations.baseline[0]!.output.length).toBeLessThan(1200);
  expect(ProcedureStudySchema.parse(await learning.report(report.runId)).evaluations.baseline[0]!.output).toBe(longOutput);
}, 70000);
it.skipIf(!process.env.DSH_TEST_OPTUNA_PYTHON)('cancels a pending model call and records the failure without a promotable report', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'djupleita-gepa-'))), session = id<'SessionId'>();
  await writeFile(join(root, 'cases.json'), JSON.stringify(await fixture()));
  const { learning, store } = await service(root, async () => new Promise(() => { setTimeout(() => learning.cancel(), 30); }));
  await expect(learning.run('cases', 24, session, AbortSignal.timeout(10000), 'gepa')).rejects.toThrow();
  expect(await learning.studies()).toMatchObject({ active: false, reports: [] });
  expect((await store.read(session)).some(event => event.type === 'learning/error')).toBe(true);
}, 15000);
