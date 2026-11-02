import { useState } from 'react';
import css from './Panel.module.css';
type Row = Record<string, unknown>;
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
interface Props {
  learning: { active: boolean; datasets: Row[]; reports: Row[]; progress?: { modelCalls: number; maxModelCalls: number } | null } | null;
  procedure: { runId: string; text: string; datasetHash: string } | null;
  busy: boolean; notice: string;
  operate(endpoint: string, payload: Row, success: string): Promise<void>;
}
export function LearningStudies({ learning, procedure, busy, notice, operate }: Props) {
  const [backend, setBackend] = useState('optuna');
  const datasets = learning?.datasets.filter(row => (row.backend ?? 'optuna') === backend) ?? [];
  return <div className={css.learning}>
    {!learning ? <p>Run <code>pnpm setup:tools --only learning</code>, then load local setup in Plugins. This installs pinned Optuna and GEPA runtimes.</p> : <>
      <p>Optuna tunes crawl priority weights. GEPA revises an authorization-testing procedure from model outputs and evaluator feedback. Both retain the dataset hash, held-out scores and trajectories. The latest ten studies are shown; full history stays in local study files and Trajectory.</p>
      <form className={css.form} onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget);
        void operate('learning/run', { backend, datasetId: values.get('dataset'), trials: Number(values.get('trials')) }, 'Study completed'); }}>
        <label>Optimizer<select name="backend" value={backend} onChange={event => setBackend(event.target.value)}><option value="optuna">Optuna · crawl ranking</option><option value="gepa">GEPA · authz procedure</option></select></label>
        <label>Dataset<select name="dataset" required key={backend}>{datasets.map(row => <option key={String(row.id)} value={String(row.id)}>{String(row.name)}</option>)}</select></label>
        <label>{backend === 'gepa' ? 'Search evaluation budget' : 'Trials'}<input name="trials" key={backend} type="number" min="2" max={backend === 'gepa' ? 300 : 1000} defaultValue={backend === 'gepa' ? 24 : 30} required /></label>
        {backend === 'gepa' && <p>Uses your selected chat model for task evaluation and reflection; provider charges apply. Recorded observations only, with no target or assessment-tool calls. At least 2 × validation cases + 4 search evaluations. Additional baseline/test calls are bounded separately (search budget + 4 × dataset rows + 12). Deadline: 15 minutes. Labels and evaluator remain fixed.</p>}
        <button className={css.button} disabled={busy || learning.active || !datasets.length}>{backend === 'gepa' ? 'Run GEPA study' : 'Run offline study'}</button>
      </form>
      {learning.active && <div role="status"><p>Study running · model calls {learning.progress?.modelCalls ?? 0} / {learning.progress?.maxModelCalls ?? 0}. Activity is saved in this chat’s Trajectory.</p>
        <button className={css.button} onClick={() => { void operate('learning/cancel', {}, 'Study cancellation requested'); }}>Cancel study</button></div>}
      {procedure && <article className={css.card}><strong>Active authz procedure</strong><code>{procedure.runId}</code><pre>{procedure.text}</pre><p>Included in agent context for this engagement. Changes take effect on the next request.</p>
        <button className={css.button} disabled={busy} onClick={() => { void operate('learning/revoke', {}, 'Procedure disabled for future requests'); }}>Disable procedure</button></article>}
      {learning.reports.map(report => {
        const gepa = report.kind === 'authz-procedure';
        const scores = report.scores as Record<string, { baseline: number; candidate: number }>;
        const promotable = scores.validation!.candidate > scores.validation!.baseline && scores.test!.candidate >= scores.test!.baseline;
        return <article className={css.card} key={String(report.runId)}>
          <strong>{String(report.engine)} · {gepa ? 'Authz procedure' : 'Crawl ranking'}</strong><code>{String(report.runId)}</code>
          <table><thead><tr><th>Split</th><th>Baseline</th><th>Candidate</th></tr></thead><tbody>{Object.entries(scores).map(([split, score]) => <tr key={split}><td>{split}</td><td>{score.baseline.toFixed(2)}</td><td>{score.candidate.toFixed(2)}</td></tr>)}</tbody></table>
          {gepa ? <>
            <ProcedureDetails report={report} />
            <details><summary>Candidate history and budget</summary><pre>{pretty({ candidates: report.candidates, budget: report.budget, model: report.model, evaluatorVersion: report.evaluatorVersion })}</pre></details>
          </> : <pre>{pretty({ parameters: report.parameters, trials: Array.isArray(report.trials) ? report.trials.length : 0 })}</pre>}
          <details><summary>Dataset provenance</summary><code>{String(report.datasetHash)}</code></details><small>{String(report.limitation)}</small>
          <button className={css.button} disabled={busy || !promotable || procedure?.runId === report.runId} onClick={() => { void operate('learning/promote', { runId: report.runId }, gepa ? 'Authz procedure promoted. Future agent requests receive it; scope and approval rules are unchanged.' : 'Crawl ranking promoted. Scope and effect rules stay operator-controlled.'); }}>{gepa ? 'Promote procedure' : 'Promote ranking'}</button>
          {!promotable && <small>Promotion requires improved validation and no held-out test regression.</small>}
        </article>;
      })}
    </>}
    <p role="status">{notice}</p>
  </div>;
}

interface CaseEvaluation { id: string; split: string; output: string; score: number; feedback: string }
function ProcedureDetails({ report }: { report: Row }) {
  const procedure = report.procedure as { baseline: string; candidate: string };
  const evaluations = report.evaluations as { baseline: CaseEvaluation[]; candidate: CaseEvaluation[] };
  const initial = evaluations.candidate.find(item => item.split === 'test' && item.output !== evaluations.baseline.find(before => before.id === item.id)?.output) ?? evaluations.candidate[0];
  const [caseId, setCaseId] = useState(initial?.id ?? '');
  return <>
    <details open><summary>Procedure before / after</summary><h4>Baseline</h4><p>{procedure.baseline}</p><h4>Candidate</h4><p>{procedure.candidate}</p></details>
    <details><summary>Case outputs and evaluator feedback</summary><div data-learning-case><small>Long outputs are previewed here; the complete report is saved in this chat’s learning/result trajectory.</small>
      <label>Case<select name="case" value={caseId} onChange={event => setCaseId(event.target.value)}>{evaluations.candidate.map(item => <option key={item.id} value={item.id}>{item.split} · {item.id}</option>)}</select></label>
      {(['baseline', 'candidate'] as const).map(version => {
        const item = evaluations[version].find(item => item.id === caseId);
        return item && <div key={version}><h4>{version === 'baseline' ? 'Baseline' : 'Candidate'} · evidence-complete score {item.score.toFixed(0)}</h4><pre>{item.output}</pre><p>{item.feedback}</p></div>;
      })}
    </div></details>
  </>;
}
