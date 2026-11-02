/** Offline Optuna studies with immutable data provenance and explicit promotion. */
import { mkdir, readFile, writeFile, readdir, realpath } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { z } from 'zod';
import { digest, id, PentestError } from '@dsh-pentest/contracts';
import type { Json, SessionId } from '@dsh-pentest/contracts';
import type { TrajectoryStore, Redactor } from '@dsh-pentest/trajectory';
import { runtimeReadRoots, runWorker } from '@dsh-pentest/worker';

export const RankingSchema = z.object({ auth: z.number().min(0).max(8), object: z.number().min(0).max(8),
  query: z.number().min(0).max(8), novelty: z.number().min(0).max(8) }).strict();
export type Ranking = z.infer<typeof RankingSchema>;
export const DatasetSchema = z.object({ name: z.string(), requestBudget: z.number().int().positive().max(10000),
  rows: z.array(z.object({ id: z.string(), split: z.enum(['train', 'validation', 'test']),
    features: z.object({ auth: z.number().min(0).max(1), object: z.number().min(0).max(1), query: z.number().min(0).max(1), novelty: z.number().min(0).max(1) }),
    reward: z.number().min(0), cost: z.number().positive(), evidenceIds: z.array(z.string()).min(1) })).min(6).max(100000) });
export const LearningConfigSchema = z.object({ python: z.string(), script: z.string(), datasets: z.string() });
export type LearningConfig = z.infer<typeof LearningConfigSchema>;
const ScoreSchema = z.object({ baseline: z.number(), candidate: z.number() });
export const StudySchema = z.object({ runId: z.string().uuid(), datasetHash: z.string(), seed: z.number(), engine: z.string(),
  parameters: RankingSchema, scores: z.object({ train: ScoreSchema, validation: ScoreSchema, test: ScoreSchema }),
  trials: z.array(z.object({ number: z.number(), value: z.number().nullable(), parameters: z.record(z.string(), z.number()), state: z.string() })), limitation: z.string() });
export class LearningService {
  private active = false;
  constructor(readonly config: LearningConfig, private readonly root: string, private readonly trajectories: TrajectoryStore,
    private readonly redactor: Redactor) { LearningConfigSchema.parse(config); }
  async datasets(): Promise<{ id: string; name: string; hash: string }[]> {
    const files = await readdir(this.config.datasets).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const result = [];
    for (const file of files.filter(file => /^[a-zA-Z0-9_-]+\.json$/.test(file))) {
      const dataset = await this.dataset(file.slice(0, -5)); result.push({ id: file.slice(0, -5), name: dataset.name, hash: digest(dataset) });
    }
    return result;
  }
  private async dataset(datasetId: string): Promise<z.infer<typeof DatasetSchema>> {
    if (!/^[a-zA-Z0-9_-]+$/.test(datasetId)) throw new PentestError('LEARNING_DATASET', 'Invalid dataset identifier');
    const base = await realpath(this.config.datasets), path = await realpath(join(base, `${datasetId}.json`));
    if (relative(base, path).startsWith('..')) throw new PentestError('LEARNING_DATASET', 'Dataset must be inside its operator-selected directory');
    const dataset = DatasetSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (new Set(dataset.rows.map(row => row.id)).size !== dataset.rows.length) throw new PentestError('LEARNING_LEAKAGE', 'Dataset row IDs must be unique across splits');
    for (const split of ['train', 'validation', 'test']) if (dataset.rows.filter(row => row.split === split).length < 2) throw new PentestError('LEARNING_SPLIT', 'Each isolated split requires at least two labelled rows');
    const evidenceSplits = new Map<string, string>();
    for (const row of dataset.rows) for (const evidence of row.evidenceIds) {
      const prior = evidenceSplits.get(evidence);
      if (prior && prior !== row.split) throw new PentestError('LEARNING_LEAKAGE', 'Evidence cannot cross dataset splits'); evidenceSplits.set(evidence, row.split);
    }
    return dataset;
  }
  async run(datasetId: string, trials: number, session: SessionId, signal: AbortSignal): Promise<Json> {
    if (this.active) throw new PentestError('LEARNING_BUSY', 'A study is already running');
    if (!Number.isInteger(trials) || trials < 2 || trials > 1000) throw new PentestError('LEARNING_TRIALS', 'Choose between 2 and 1000 trials');
    this.active = true;
    try {
      const dataset = await this.dataset(datasetId), runId = id<'StudyId'>(), datasetHash = digest(dataset), seed = 42;
      const directory = join(this.root, runId); await mkdir(directory, { recursive: true, mode: 0o700 });
      const request = { dataset, datasetHash, runId, seed, trials };
      await writeFile(join(directory, 'request.json'), JSON.stringify(request), { mode: 0o600, flag: 'wx' });
      await this.trajectories.append(session, 'learning/start', { runId, datasetId, datasetHash, seed, trials, source: 'offline-labelled-data' });
      const result = await runWorker({ executable: this.config.python,
        args: [this.config.script, '--input', join(directory, 'request.json'), '--output', join(directory, 'report.json')], cwd: directory,
        timeoutMs: 300000, maxOutputBytes: 2 * 1024 * 1024, env: { PYTHONDONTWRITEBYTECODE: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } },
        { writableRoots: [directory], readableRoots: [...runtimeReadRoots([dirname(dirname(this.config.python)), dirname(dirname(await realpath(this.config.python)))]), this.config.script, directory] }, signal);
      if (result.exitCode !== 0) throw new PentestError('LEARNING_WORKER', this.redactor.text(result.stderr || 'Optuna worker failed'));
      const report = await this.report(runId);
      if (report.datasetHash !== datasetHash) throw new PentestError('LEARNING_PROVENANCE', 'Study report does not match the committed dataset');
      await this.trajectories.append(session, 'learning/result', this.redactor.json(report));
      return this.redactor.json(report);
    } finally { this.active = false; }
  }
  async report(runId: string): Promise<z.infer<typeof StudySchema>> {
    z.string().uuid().parse(runId); return StudySchema.parse(JSON.parse(await readFile(join(this.root, runId, 'report.json'), 'utf8')));
  }
  async studies(): Promise<Json> {
    const dirs = await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const reports: Json[] = [];
    for (const dir of dirs.filter(dir => z.string().uuid().safeParse(dir).success)) {
      try { reports.push(this.redactor.json(await this.report(dir))); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    }
    return { active: this.active, datasets: await this.datasets(), reports };
  }
  async promotion(runId: string, session: SessionId): Promise<Ranking> {
    const report = await this.report(runId);
    if (report.scores.validation.candidate <= report.scores.validation.baseline || report.scores.test.candidate < report.scores.test.baseline) {
      throw new PentestError('LEARNING_REGRESSION', 'Promotion requires a validation improvement and no held-out test regression');
    }
    await this.trajectories.append(session, 'learning/promotion-request', { runId, source: 'desktop-owner', parameters: report.parameters, datasetHash: report.datasetHash });
    return report.parameters;
  }
}
