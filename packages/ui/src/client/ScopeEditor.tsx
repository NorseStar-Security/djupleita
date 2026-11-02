import { useState } from 'react';
import { initialScopeDraft, scopeExample, scopePreview } from './scope-draft.ts';
import css from './Panel.module.css';

export function ScopeEditor({ scope, title }: { scope: Record<string, unknown>; title: string }) {
  const [draft, setDraft] = useState(() => initialScopeDraft(scope));
  const insertExampleTargets = () => {
    let current = scope;
    try {
      const parsed: unknown = JSON.parse(draft);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as Record<string, unknown>;
    } catch { /* Restore from saved settings when the draft is blank or invalid JSON. */ }
    setDraft(initialScopeDraft({ ...current, targets: [] }));
  };
  return <>
    <label>{title}<textarea className={css.editor} name="scope" value={draft} onChange={event => setDraft(event.target.value)} required spellCheck={false} /></label>
    <button type="button" className={css.button} onClick={insertExampleTargets}>Insert example targets</button>
    <p>Replace example.test throughout with your authorized domain and choose the host or subtree to exclude. The apex needs its own rule; *.example.test covers subdomains only. The two exclusion rules exclude the named host and all its descendants.</p>
    <p>This example covers HTTP and HTTPS on ports 80/443 and every path. It is inactive until Apply. For internal targets, use complete host rules, allow private addresses only where intended, and add the authorized CIDRs to networks. A direct IP target also requires a matching network grant.</p>
    <details><summary>Working target and exclusion example</summary><pre>{JSON.stringify(scopeExample, null, 2)}</pre></details>
    <details open><summary>Draft scope preview</summary><pre aria-live="polite">{scopePreview(draft)}</pre></details>
  </>;
}
