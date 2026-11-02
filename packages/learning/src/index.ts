/** Confined Optuna ranking and GEPA procedure studies with explicit operator promotion. */
import { mkdir, readFile, writeFile, readdir, realpath, lstat, rename } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { digest, id, PentestError } from '@dsh-pentest/contracts';
import type { Json, SessionId, ModelSelection } from '@dsh-pentest/contracts';
import type { TrajectoryStore, Redactor } from '@dsh-pentest/trajectory';
import { runtimeReadRoots, runWorker } from '@dsh-pentest/worker';
import { DatasetSchema, ProcedureDatasetSchema, LearningConfigSchema, StudySchema, ProcedureStudySchema, ModelRequestSchema } from './schema.ts';
import type { LearningConfig, LearningModel, Ranking, ProcedurePromotion } from './schema.ts';
export * from './schema.ts';
export class LearningService {
  private active = false;
  private readonly previews = new Map<string, { version: string; report: Json }>();
  private progress: { runId: string; backend: string; modelCalls: number; maxModelCalls: number } | null = null;
  private controller?: AbortController;
  constructor(readonly config: LearningConfig, private readonly root: string, private readonly trajectories: TrajectoryStore,
    private readonly redactor: Redactor, private readonly model?: LearningModel, private readonly selection?: (session: SessionId) => Readonly<ModelSelection>) { LearningConfigSchema.parse(config); }
  async datasets(): Promise<{ id: string; name: string; hash: string; backend: string }[]> {
    const files = await readdir(this.config.datasets).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    return Promise.all(files.filter(file => /^[a-zA-Z0-9_-]+\.json$/.test(file)).map(async file => {
      const dataset = await this.dataset(file.slice(0, -5));
      return { id: file.slice(0, -5), name: dataset.name, hash: digest(dataset), backend: 'kind' in dataset ? 'gepa' : 'optuna' };
    }));
  }
  private async dataset(datasetId: string): Promise<z.infer<typeof DatasetSchema> | z.infer<typeof ProcedureDatasetSchema>> {
    if (!/^[a-zA-Z0-9_-]+$/.test(datasetId)) throw new PentestError('LEARNING_DATASET', 'Invalid dataset identifier');
    const base = await realpath(this.config.datasets), path = await realpath(join(base, `${datasetId}.json`));
    if (relative(base, path).startsWith('..')) throw new PentestError('LEARNING_DATASET', 'Dataset must be inside its operator-selected directory');
    const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
    const dataset = z.union([ProcedureDatasetSchema, DatasetSchema]).parse(this.redactor.json(raw));
    if (new Set(dataset.rows.map(row => row.id)).size !== dataset.rows.length) throw new PentestError('LEARNING_LEAKAGE', 'Dataset row IDs must be unique across splits');
    for (const split of ['train', 'validation', 'test']) if (dataset.rows.filter(row => row.split === split).length < 2) throw new PentestError('LEARNING_SPLIT', 'Each isolated split requires at least two labelled rows');
    const splits = new Map<string, string>();
    for (const row of dataset.rows) for (const evidence of [...row.evidenceIds.map(key => `evidence:${key}`), ...('appId' in row ? [`app:${row.appId}`] : [])]) {
      const prior = splits.get(evidence);
      if (prior && prior !== row.split) throw new PentestError('LEARNING_LEAKAGE', 'Evidence and applications cannot cross dataset splits'); splits.set(evidence, row.split);
    }
    return dataset;
  }
  cancel(): void { this.controller?.abort(new PentestError('LEARNING_CANCELLED', 'Study cancelled by the operator')); }
  async run(datasetId: string, trials: number, session: SessionId, signal: AbortSignal, backend: 'optuna' | 'gepa' = 'optuna'): Promise<Json> {
    if (this.active) throw new PentestError('LEARNING_BUSY', 'A study is already running');
    if (!Number.isInteger(trials) || trials < 2 || trials > 1000 || (backend === 'gepa' && trials > 300)) throw new PentestError('LEARNING_TRIALS', 'Choose 2–1000 trials, or 2–300 GEPA search evaluations');
    this.active = true; this.controller = new AbortController();
    const runSignal = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(900000)]);
    let runId: string | undefined;
    try {
      const dataset = await this.dataset(datasetId);
      if (('kind' in dataset) !== (backend === 'gepa')) throw new PentestError('LEARNING_BACKEND', 'Select the backend matching this dataset: Optuna for ranking, GEPA for authz procedures');
      if (backend === 'gepa' && (!this.config.gepaScript || !this.model || !this.selection)) throw new PentestError('LEARNING_CONFIG', 'Load the updated learning setup and select a chat model before running GEPA');
      runId = id<'StudyId'>(); const datasetHash = digest(dataset), seed = 42;
      const directory = join(this.root, runId); await mkdir(directory, { recursive: true, mode: 0o700 });
      const maxModelCalls = trials + 4 * dataset.rows.length + 12;
      const selected = backend === 'gepa' ? this.selection!(session) : undefined;
      const selection = selected ? Object.freeze({ provider: selected.provider, model: selected.model }) : undefined;
      if (backend === 'gepa' && trials < 2 * dataset.rows.filter(row => row.split === 'validation').length + 4) throw new PentestError('LEARNING_BUDGET', 'GEPA requires at least 2 × validation rows + 4 search evaluations');
      const request = { dataset: this.redactor.json(dataset), datasetHash, runId, seed, trials, maxModelCalls,
        ...(backend === 'gepa' ? { model: selection } : {}) };
      await writeFile(join(directory, 'request.json'), JSON.stringify(request), { mode: 0o600, flag: 'wx' });
      await this.trajectories.append(session, 'learning/start', { runId, backend, datasetId, datasetHash, seed, trials, maxModelCalls, source: 'operator-labelled-recordings' });
      this.progress = { runId, backend, modelCalls: 0, maxModelCalls };
      const script = backend === 'gepa' ? this.config.gepaScript! : this.config.script;
      const bridgeStop = new AbortController();
      const workerStop = new AbortController();
      const workerSignal = AbortSignal.any([runSignal, workerStop.signal]);
      let bridgeError: unknown;
      const bridge = backend === 'gepa' ? this.bridge(directory, session, maxModelCalls, AbortSignal.any([workerSignal, bridgeStop.signal]), selection!).catch(error => {
        if (!bridgeStop.signal.aborted) { bridgeError = error; workerStop.abort(); }
      }) : Promise.resolve();
      let result;
      try {
        result = await runWorker({ executable: this.config.python, args: [script, '--input', join(directory, 'request.json'), '--output', join(directory, 'report.json')], cwd: directory,
          timeoutMs: 900000, maxOutputBytes: 2 * 1024 * 1024, env: { PYTHONDONTWRITEBYTECODE: '1', OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1' } },
          { writableRoots: [directory], readableRoots: [...runtimeReadRoots([dirname(dirname(this.config.python)), dirname(dirname(await realpath(this.config.python)))]), script, directory] }, workerSignal);
      } catch (error) { throw bridgeError ?? error; }
      finally { bridgeStop.abort(); await bridge; }
      if (bridgeError) throw bridgeError;
      if (result.exitCode !== 0) throw new PentestError('LEARNING_WORKER', this.redactor.text(result.stderr || 'Learning worker failed'));
      const report = await this.report(runId);
      if (report.datasetHash !== datasetHash || report.runId !== runId) throw new PentestError('LEARNING_PROVENANCE', 'Study report does not match the committed dataset');
      await this.trajectories.append(session, 'learning/result', this.redactor.json(report));
      return this.redactor.json(report);
    } catch (error) {
      await this.trajectories.append(session, 'learning/error', this.redactor.json({ runId: runId ?? null, error: error instanceof Error ? error.message : 'Study failed' })); throw error;
    } finally { this.active = false; this.progress = null; delete this.controller; }
  }
  /** Only trusted worker files are accepted; Python has no network, inherited keys or tool access. */
  private async bridge(directory: string, session: SessionId, maxCalls: number, signal: AbortSignal, selection: Readonly<ModelSelection>): Promise<void> {
    for (let call = 1; !signal.aborted; call++) {
      const path = join(directory, `model-request-${call}.json`);
      while (!signal.aborted) {
        const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
        if (stat) {
          if (!stat.isFile() || stat.size > 160000 || await realpath(path) !== path) throw new PentestError('LEARNING_BRIDGE', 'Invalid worker model request');
          break;
        }
        await delay(40, undefined, { signal });
      }
      signal.throwIfAborted();
      if (call > maxCalls) throw new PentestError('LEARNING_BUDGET', 'Study exhausted its model-call budget');
      const request = ModelRequestSchema.parse(this.redactor.json(JSON.parse(await readFile(path, 'utf8'))));
      if (this.progress) this.progress.modelCalls = call;
      await this.trajectories.append(session, 'learning/model-request', this.redactor.json({ runId: this.progress?.runId ?? '', call, ...request }));
      let abort!: () => void;
      const cancelled = new Promise<string>((_resolve, reject) => {
        abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
      let text: string;
      try { text = await Promise.race([this.model!(session, request, signal, selection), cancelled]); }
      finally { signal.removeEventListener('abort', abort); }
      if (Buffer.byteLength(text) > 32768) throw new PentestError('LEARNING_OUTPUT', 'Learning model response exceeds 32 KiB');
      await this.trajectories.append(session, 'learning/model-result', this.redactor.json({ runId: this.progress?.runId ?? '', call, purpose: request.purpose, text }));
      const temporary = join(directory, `model-response-${call}.tmp`);
      await writeFile(temporary, JSON.stringify({ text: this.redactor.text(text) }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(directory, `model-response-${call}.json`));
    }
  }
  async report(runId: string): Promise<z.infer<typeof StudySchema>> {
    z.string().uuid().parse(runId); const path = join(this.root, runId, 'report.json');
    if ((await lstat(path)).size > 16000000) throw new PentestError('LEARNING_REPORT', 'Study report exceeds its size limit');
    return StudySchema.parse(JSON.parse(await readFile(path, 'utf8')));
  }
  async studies() {
    const dirs = await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error; });
    const entries = await Promise.all(dirs.filter(dir => z.string().uuid().safeParse(dir).success).map(async runId => {
      const stat = await lstat(join(this.root, runId, 'report.json')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
      return stat ? { runId, modified: stat.mtimeMs, version: stat.mtimeMs + ':' + stat.size } : null;
    }));
    const recent = entries.filter(entry => entry !== null).sort((a, b) => b.modified - a.modified).slice(0, 10);
    const retained = new Set(recent.map(entry => entry.runId));
    for (const key of this.previews.keys()) if (!retained.has(key)) this.previews.delete(key);
    const reports: Json[] = [];
    for (const entry of recent) {
      let preview = this.previews.get(entry.runId);
      if (preview?.version !== entry.version) {
        const report = await this.report(entry.runId);
        const shorten = (text: string) => text.length > 1000 ? text.slice(0, 1000) + '\n[Preview shortened; full output is saved in the learning/result trajectory.]' : text;
        const summary = 'evaluations' in report ? { ...report,
          evaluations: { baseline: report.evaluations.baseline.map(item => ({ ...item, output: shorten(item.output) })), candidate: report.evaluations.candidate.map(item => ({ ...item, output: shorten(item.output) })) },
          candidates: report.candidates.map(item => ({ ...item, procedure: shorten(item.procedure) })) } : report;
        preview = { version: entry.version, report: this.redactor.json(summary) }; this.previews.set(entry.runId, preview);
      }
      reports.push(preview.report);
    }
    return { active: this.active, progress: this.progress, datasets: await this.datasets(), reports, historyLimit: 10 };
  }

  async promotion(runId: string, session: SessionId): Promise<Ranking | ProcedurePromotion> {
    const report = await this.report(runId);
    if (report.scores.validation.candidate <= report.scores.validation.baseline || report.scores.test.candidate < report.scores.test.baseline) throw new PentestError('LEARNING_REGRESSION', 'Promotion requires a validation improvement and no held-out test regression');
    const procedure = ProcedureStudySchema.safeParse(report);
    const result = procedure.success ? { runId, datasetHash: report.datasetHash, text: procedure.data.procedure.candidate } : ('parameters' in report ? report.parameters : null);
    if (!result) throw new PentestError('LEARNING_REPORT', 'Unknown study artifact');
    await this.trajectories.append(session, 'learning/promotion-request', this.redactor.json({ runId, source: 'desktop-owner', artifact: result, datasetHash: report.datasetHash }));
    return result;
  }
}

/** Model-facing receipts never replay case histories into the LLM context. */
export function studyReceipt(value: unknown): Json {
  const report = StudySchema.parse(value);
  return { runId: report.runId, datasetHash: report.datasetHash, engine: report.engine.slice(0, 128), scores: report.scores,
    limitation: report.limitation.slice(0, 1000), fullReport: 'Open Studies or this chat’s saved learning/result trajectory for procedures, cases and history.',
    ...('procedure' in report ? { kind: report.kind, procedurePreview: report.procedure.candidate.slice(0, 1000), candidateCount: report.candidates.length, budget: report.budget }
      : { kind: 'crawl-ranking', parameters: report.parameters, trialCount: report.trials.length }) };
}
