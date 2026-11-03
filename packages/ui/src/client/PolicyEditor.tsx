import { useState } from 'react';
import css from './Panel.module.css';

const defaults = { research: 'allow', recon: 'allow', workspace: 'allow', unknown: 'judge', destructive: 'ask' };
const labels = { research: 'Research and passive discovery', recon: 'Bounded reconnaissance', workspace: 'Workspace file changes', unknown: 'Unknown effects', destructive: 'Destructive actions' };
export function PolicyEditor({ policy }: { policy: Record<string, unknown> }) {
  const [draft, setDraft] = useState(() => JSON.stringify(policy, null, 2));
  let parsed: Record<string, unknown> | undefined;
  try { const value = JSON.parse(draft); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value; } catch { /* Keep the raw editor repairable. */ }
  const change = (values: Record<string, unknown>) => setDraft(JSON.stringify({ ...parsed, ...values }, null, 2));
  const redTeam = { ...defaults, ...(parsed?.redTeam as Record<string, string> | undefined) };
  return <>
    <h3>Action policy</h3>
    <p role="status">Applied action profile: <strong>{policy.profile === 'red-team' ? 'Red team' : 'Review'}</strong>. {draft !== JSON.stringify(policy, null, 2) ? 'Unapplied policy changes.' : 'The editor matches the saved policy.'}</p>
    <label>Action profile<select aria-label="Action profile" disabled={!parsed} value={String(parsed?.profile ?? 'review')} onChange={event => change({ profile: event.target.value })}>
      <option value="review">Review · conservative approvals</option><option value="red-team">Red team · configurable approvals</option>
    </select></label>
    <p>Red team allows low-risk judgments without a separate confidence veto. Destructive risk or failed judgment requires review. Scope is checked independently.</p>
    {parsed?.profile === 'red-team' && Object.entries(labels).map(([key, label]) => <label key={key}>{label}<select aria-label={label} value={redTeam[key as keyof typeof defaults]} onChange={event => change({ redTeam: { ...redTeam, [key]: event.target.value } })}>
      {(key === 'unknown' ? ['judge', 'allow', 'ask', 'deny'] : key === 'destructive' ? ['ask', 'deny'] : ['allow', 'ask', 'deny']).map(value => <option key={value} value={value}>{value === 'judge' ? 'LLM judgment' : value === 'ask' ? 'Ask for review' : value === 'deny' ? 'Block' : 'Allow'}</option>)}
    </select></label>)}
    {parsed?.profile === 'red-team' && redTeam.unknown === 'allow' && <p>Unknown effects: Allow skips effect judgment for unclassified operations, including shell commands. It cannot identify destructive behavior hidden in unknown code or verify shell destinations. Known destructive effects and other access controls still apply; use managed tools for enforced network scope.</p>}
    <p>Known destructive effects require review or are blocked. The LLM cannot expand target scope. Changes activate with Apply scope and policy.</p>
    <details><summary>Advanced policy JSON</summary><label>Policy<textarea className={css.editor} name="policy" value={draft} onChange={event => setDraft(event.target.value)} required spellCheck={false} /></label></details>
  </>;
}
