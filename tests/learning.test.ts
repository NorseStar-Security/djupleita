import { it, expect } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { LearningService } from '../packages/learning/src/index.ts';
import { Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';

it('rejects evidence leakage across offline evaluation splits before starting a worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-learning-'));
  const dataset = JSON.parse(await readFile(resolve('configs/datasets/lab-ranking.json'), 'utf8'));
  dataset.rows[2].evidenceIds = dataset.rows[0].evidenceIds;
  await writeFile(join(root, 'leaky.json'), JSON.stringify(dataset));
  const redactor = new Redactor(), store = new TrajectoryStore(join(root, 'events'), id<'EngagementId'>(), redactor);
  const service = new LearningService({ python: '/unused', script: '/unused', datasets: root }, join(root, 'runs'), store, redactor);
  await expect(service.run('leaky', 2, id<'SessionId'>(), new AbortController().signal)).rejects.toThrow('cross dataset splits');
  await expect(service.run('../escape', 2, id<'SessionId'>(), new AbortController().signal)).rejects.toThrow('identifier');
});
it.skipIf(!process.env.DSH_TEST_OPTUNA_PYTHON)('runs a real confined Optuna study and promotes only a held-out improvement', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-optuna-'))), redactor = new Redactor();
  const store = new TrajectoryStore(join(root, 'events'), id<'EngagementId'>(), redactor), session = id<'SessionId'>();
  const service = new LearningService({ python: process.env.DSH_TEST_OPTUNA_PYTHON!, script: resolve('packages/learning/python/optimize.py'), datasets: resolve('configs/datasets') }, join(root, 'runs'), store, redactor);
  const report = await service.run('lab-ranking', 12, session, AbortSignal.timeout(60000)) as Record<string, unknown>;
  expect(String(report.engine)).toMatch(/^optuna\//); expect(report.trials).toHaveLength(12);
  const ranking = await service.promotion(String(report.runId), session); expect(ranking.object).toBeGreaterThan(ranking.auth);
  expect((await store.read(session)).map(event => event.type)).toContain('learning/promotion-request');
  const reportPath = join(root, 'runs', String(report.runId), 'report.json');
  const changed = JSON.parse(await readFile(reportPath, 'utf8')); changed.scores.test.candidate = -1;
  await writeFile(reportPath, JSON.stringify(changed));
  await expect(service.promotion(String(report.runId), session)).rejects.toThrow('held-out test regression');
}, 70000);
