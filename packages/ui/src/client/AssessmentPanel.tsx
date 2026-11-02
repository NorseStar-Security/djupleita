import { useEffect, useRef, useState } from 'react';
import type { ReactNode, FormEvent } from 'react';
import type { Run } from '../../../assessment/src/index.ts';
import css from './Panel.module.css';

type Row = Record<string, unknown>;
interface Props { sessionId: string; identities: Row[]; inspect<T>(endpoint: string, payload: Row): Promise<T> }
interface RunPage { runs: Pick<Run, 'id' | 'title' | 'state' | 'updatedAt'>[]; nextOffset: number | null }
interface Scorecard { requests: number; errors: number; coverage: { tested: number; total: number; waived: number }; alerts: string[] }
const text = (form: FormData, key: string): string => String(form.get(key) ?? '').trim();
const pretty = (value: unknown): string => JSON.stringify(value, null, 2);
const blankPlan = { title: 'Web/API assessment', maxRequests: 30, validationReserve: 6,
  cells: [{ surface: 'https://example.test/objects/1', method: 'GET', input: 'object ID', family: 'authorization', identity: 'anonymous' }] };

/** Owner-only controls. Proof bodies load on demand and are bounded to one evidence page. */
export function AssessmentPanel({ inspect, identities, sessionId }: Props): ReactNode {
  const [page, setPage] = useState<RunPage>({ runs: [], nextOffset: null });
  const [selected, setSelected] = useState(''), [run, setRun] = useState<Run>(), [score, setScore] = useState<Scorecard>();
  const [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [reason, setReason] = useState('');
  const [proof, setProof] = useState<{ evidenceId: string; text: string; nextOffset: number | null }>();
  const generation = useRef(0);
  const list = async (offset = 0): Promise<void> => setPage(await inspect<RunPage>('assessment/list', { offset }));
  const load = async (runId: string): Promise<void> => {
    const epoch = ++generation.current;
    const value = await inspect<{ run: Run; scorecard: Scorecard }>('assessment/get', { runId });
    if (generation.current !== epoch) return;
    setRun(value.run); setScore(value.scorecard); setSelected(runId); setProof(undefined);
  };
  const operate = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true); setNotice('');
    try { await operation(); } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  useEffect(() => { generation.current++; setRun(undefined); setSelected(''); setProof(undefined); void operate(() => list()); }, [sessionId]);
  const mutate = async (endpoint: string, payload: Row): Promise<void> => {
    await inspect(endpoint, { runId: selected, ...payload }); await list(); await load(selected); setNotice('Saved.');
  };
  const control = (operation: string): void => { void operate(() => mutate('assessment/control', { operation, reason })); };
  const evidence = (evidenceId: string, offset = 0): void => { void operate(async () => {
    const value = await inspect<{ text: string; nextOffset: number | null }>('assessment/evidence', { runId: selected, evidenceId, offset });
    setProof({ evidenceId, ...value });
  }); };
  const download = (value: string, suffix: string, type: string): void => {
    const url = URL.createObjectURL(new Blob([value], { type })), anchor = document.createElement('a');
    anchor.href = url; anchor.download = `assessment-${selected}.${suffix}`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const configure = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void operate(() => mutate('assessment/configure', { readiness: { url: text(form, 'url'), expectedText: text(form, 'expectedText'),
      ...(text(form, 'identityId') ? { identityId: text(form, 'identityId') } : {}), browserRequired: form.get('browserRequired') === 'on', ttlMs: Number(form.get('freshnessSeconds')) * 1000 },
      assertions: JSON.parse(text(form, 'assertions')) }));
  };
  const options = <>{identities.map(identity => <option key={String(identity.id)} value={String(identity.id)}>{String(identity.name)} · {String(identity.id)}</option>)}</>;
  return <div className={css.assessment}>
    <h3>Assessment</h3><p>Bounded runs, readiness, declared coverage and independently reviewed proofs.</p>
    {notice && <p className={css.error} role="status">{notice}</p>}
    <div className={css.setupActions}>
      <select aria-label="Assessment run" value={selected} disabled={busy} onChange={event => { const id = event.target.value; if (id) void operate(() => load(id)); }}>
        <option value="">Select a run</option>{page.runs.map(item => <option key={item.id} value={item.id}>{item.title} · {item.state}</option>)}
      </select>
      <button disabled={busy} onClick={() => { void operate(async () => { await list(); if (selected) await load(selected); }); }}>Refresh</button>
      {page.nextOffset !== null && <button disabled={busy} onClick={() => { void operate(() => list(page.nextOffset!)); }}>Older runs</button>}
      <button disabled={busy} onClick={() => { void operate(() => list()); }}>Latest runs</button>
    </div>
    <details><summary>Start a run</summary><p>Set the actual authorized URLs and identity references before starting. The assistant can also prepare this plan.</p>
      <form className={css.form} onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void operate(async () => {
        const created = await inspect<Run>('assessment/plan', { sessionId, plan: JSON.parse(text(form, 'plan')) }); await list(); await load(created.id);
      }); }}><label>Declared plan<textarea name="plan" rows={12} defaultValue={pretty(blankPlan)} required /></label><button disabled={busy}>Start bounded run</button></form>
    </details>
    {run && <>
      <h3>{run.title}</h3><p><code>{run.id}</code> · {run.state} · {run.reason}</p>
      {score && <><div className={css.assessmentStats}><span><strong>{score.coverage.tested}/{score.coverage.total}</strong> cells tested</span>
        <span><strong>{score.requests}/{run.maxRequests}</strong> requests</span><span><strong>{score.errors}</strong> failures</span><span><strong>{score.coverage.waived}</strong> waived</span></div>
        {score.alerts.length > 0 && <ul>{score.alerts.map(alert => <li key={alert}>{alert}</li>)}</ul>}</>}
      <label>Reason for run control, waiver or finding review<input value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></label>
      <div className={css.setupActions}>{(['pause', 'resume', 'cancel', 'fail', 'complete'] as const).map(operation =>
        <button key={operation} disabled={busy || !reason.trim() || ['completed', 'cancelled', 'failed'].includes(run.state)
          || operation === 'resume' && run.state !== 'paused' || operation === 'pause' && run.state !== 'active'} onClick={() => control(operation)}>
          {({ pause: 'Pause', resume: 'Resume', cancel: 'Cancel', fail: 'Mark failed', complete: 'Complete' })[operation]}</button>)}</div>
      <details key={`${run.id}/${run.updatedAt}`}><summary>Readiness and trusted assertions</summary>
        <p>Use known non-secret content to prove that the correct page and session are working. Saving changes invalidates previous readiness and finding reviews.</p>
        <form className={css.form} onSubmit={configure}>
          <label>Readiness URL<input name="url" type="url" required defaultValue={run.readinessContract?.url ?? ''} /></label>
          <label>Expected page text<input name="expectedText" minLength={3} maxLength={500} required defaultValue={run.readinessContract?.expectedText ?? ''} /></label>
          <label>Readiness identity<select name="identityId" defaultValue={run.readinessContract?.identityId ?? ''}><option value="">Anonymous</option>{options}</select></label>
          <label>Readiness freshness (seconds)<input name="freshnessSeconds" type="number" min={1} max={3600} step={1} defaultValue={(run.readinessContract?.ttlMs ?? 300000) / 1000} /></label>
          <label><input name="browserRequired" type="checkbox" defaultChecked={run.readinessContract?.browserRequired ?? false} />Require rendered browser content</label>
          <p>Object assertions specify id, title, url, ownerIdentityId, optional otherIdentityId, jsonPointer, expectedValue and negativeControlUrl. Use a non-secret expected string value and a distinct control URL on the same origin. Omitting otherIdentityId tests anonymous access.</p>
          <label>Trusted object assertions (JSON)<textarea name="assertions" rows={12} defaultValue={pretty(run.assertions)} /></label>
          <button disabled={busy}>Save readiness and assertions</button>
        </form>
      </details>
      <details><summary>Coverage · {run.cells.length} {run.cells.length === 1 ? 'cell' : 'cells'}</summary>{run.cells.map(cell => <article key={cell.id} className={css.setupEntry}>
        <strong>{cell.method} {cell.surface}</strong><p>{cell.family} · {cell.input} · {cell.identity} · {cell.status}</p><p>{cell.reason}</p>
        <button disabled={busy || !reason.trim()} onClick={() => { void operate(() => mutate('assessment/waive', { cellId: cell.id, reason })); }}>Mark not applicable with reason</button>
      </article>)}</details>
      <details><summary>Leads · {run.leads.length}</summary>{run.leads.map(lead => <article key={lead.key} className={css.setupEntry}><strong>{lead.summary}</strong><p>{lead.reason} · {lead.key}</p></article>)}</details>
      <h3>Finding review</h3><p>Inspect the proof and negative control before accepting. Acceptance adds a current deterministic proof to reports.</p>
      {run.findings.length === 0 && <p>No proof results yet. Ask the assistant to run an installed assertion after readiness passes.</p>}
      {run.findings.map(finding => <article key={finding.id} className={css.setupEntry}>
        <strong>{finding.title}</strong><p>{finding.status} · review {finding.reviewed}</p><p>{finding.reason}</p><p>{finding.reviewReason}</p>
        <div className={css.setupActions}>{finding.evidenceIds.map((id, index) => <button key={id} disabled={busy} onClick={() => evidence(id)}>Inspect evidence {index + 1}</button>)}</div>
        <div className={css.setupActions}><button disabled={busy || !reason.trim() || finding.status !== 'verified'} onClick={() => { void operate(() => mutate('assessment/review', { findingId: finding.id, accept: true, reason })); }}>Accept proof</button>
          <button disabled={busy || !reason.trim()} onClick={() => { void operate(() => mutate('assessment/review', { findingId: finding.id, accept: false, reason })); }}>Reject proof</button></div>
      </article>)}
      {proof && <details open><summary>Retained proof · {proof.evidenceId}</summary><pre>{proof.text}</pre>{proof.nextOffset !== null && <button disabled={busy} onClick={() => evidence(proof.evidenceId, proof.nextOffset!)}>Next evidence page</button>}</details>}
      <div className={css.setupActions}><button disabled={busy} onClick={() => { void operate(async () => {
        const report = await inspect<{ json: unknown; markdown: string }>('assessment/report', { runId: run.id }); download(report.markdown, 'md', 'text/markdown');
      }); }}>Export Markdown report</button><button disabled={busy} onClick={() => { void operate(async () => {
        const report = await inspect<{ json: unknown; markdown: string }>('assessment/report', { runId: run.id }); download(pretty(report.json), 'json', 'application/json');
      }); }}>Export JSON evidence package</button></div>
    </>}
  </div>;
}
