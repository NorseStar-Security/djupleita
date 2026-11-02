import { useState } from 'react';
import { initialScopeDraft, scopeExample, scopePreview } from './scope-draft.ts';
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
    setDraft(initialScopeDraft({ ...current, targets: [] }));
  };
  return <>
    <p role="status">Scope management is currently <strong>{scope.enabled === false ? 'OFF' : 'ON'}</strong>. {scope.enabled === false ? 'Target boundaries are not enforced. Enable it during the course to compare behavior.' : 'Target boundaries are enforced.'}</p>
    <label className={css.scopeToggle}><input type="checkbox" role="switch" aria-label="Scope management" checked={parsed ? parsed.enabled !== false : scope.enabled !== false} disabled={!parsed}
      onChange={event => setDraft(JSON.stringify({ ...parsed, enabled: event.target.checked }, null, 2))} />Scope management</label>
    <p>The switch changes the draft. Select Apply scope and policy to activate it. Action reviews, credential host bindings, service destinations and budgets remain active.</p>
    <label>{title}<textarea className={css.editor} name="scope" value={draft} onChange={event => setDraft(event.target.value)} required spellCheck={false} /></label>
    <button type="button" className={css.button} onClick={insertExampleTargets}>Insert course targets</button>
    <p>The course permits {scopeExample.targets[0]!.host}, {scopeExample.targets[1]!.host} and {scopeExample.targets[2]!.host}. The website is the only production system in scope. All other production hosts and all outside destinations are out of scope, even if reachable.</p>
    <p>These rules cover HTTP and HTTPS on ports 80/443 and every path, including private internal addresses. Wildcards cover subdomains only. Unlisted hosts are denied when scope management is on; a production wildcard exclusion would also block the allowed website because exclusions take precedence.</p>
    <details><summary>Default course scope</summary><pre>{JSON.stringify(scopeExample, null, 2)}</pre></details>
    <details open><summary>Draft scope preview</summary><pre aria-live="polite">{scopePreview(draft)}</pre></details>
  </>;
}
