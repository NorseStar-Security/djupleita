import { useState } from 'react';
import { initialScopeDraft, courseScopeDraft, scopeExample, scopePreview } from './scope-draft.ts';
import css from './Panel.module.css';

export function ScopeEditor({ scope, title }: { scope: Record<string, unknown>; title: string }) {
  const [draft, setDraft] = useState(() => initialScopeDraft(scope));
  let parsed: Record<string, unknown> | undefined;
  try { const value: unknown = JSON.parse(draft); if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as Record<string, unknown>; } catch { /* The preview explains invalid JSON. */ }
  const insertExampleTargets = () => {
    let current = scope;
    try {
      const parsed: unknown = JSON.parse(draft);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* Restore from saved settings when the draft is blank or invalid JSON. */ }
    setDraft(courseScopeDraft(current));
  };
  return <>
    <p role="status">Scope management is currently <strong>{scope.enabled === false ? 'OFF' : 'ON'}</strong>. {scope.enabled === false ? 'Target boundaries are not enforced. Enable it during the course to compare behavior.' : 'Target boundaries are enforced.'}</p>
    <p role="status">Saved scope available to the agent: {Array.isArray(scope.targets) ? scope.targets.length : 0} target rules. {draft !== initialScopeDraft(scope) ? 'Unapplied draft changes. Select Apply scope and policy to save them.' : 'The editor matches the saved scope.'}</p>
    <label className={css.scopeToggle}><input type="checkbox" role="switch" aria-label="Scope management" checked={parsed ? parsed.enabled !== false : scope.enabled !== false} disabled={!parsed}
      onChange={event => setDraft(JSON.stringify({ ...parsed, enabled: event.target.checked }, null, 2))} />Scope management</label>
    <p>The switch changes the draft. Select Apply scope and policy to activate it. Action reviews, credential host bindings, service destinations and budgets remain active.</p>
    <label>{title}<textarea className={css.editor} name="scope" value={draft} onChange={event => setDraft(event.target.value)} required spellCheck={false} /></label>
    <button type="button" className={css.button} onClick={insertExampleTargets}>Insert course targets</button>
    <p>The course permits active testing of {scopeExample.targets[0]!.host}, {scopeExample.targets[1]!.host} and {scopeExample.targets[2]!.host}. The website is the only production system authorized for active testing. Ordinary web reads and passive research may use unlisted sites, such as CVE databases and exploit blogs.</p>
    <p>When scope management is on, exclusions block both research and active testing unless you explicitly approve an override. When off, target rules, exclusions and target network boundaries are inactive. These target rules cover HTTP and HTTPS on ports 80/443 and every path, including private internal addresses. Wildcards cover subdomains only. Credential bindings, action reviews and budgets remain active.</p>
    <details><summary>Default course scope</summary><pre>{JSON.stringify(scopeExample, null, 2)}</pre></details>
    <details open><summary>Draft scope preview</summary><pre aria-live="polite">{scopePreview(draft)}</pre></details>
  </>;
}
