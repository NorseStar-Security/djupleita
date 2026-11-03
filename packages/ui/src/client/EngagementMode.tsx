/** The master switch remains mounted while engagement services are unloaded. */
import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store';
import { pollingSource } from './polling.ts';
import panelCss from './Panel.module.css';
import css from './EngagementMode.module.css';

interface Mode { enabled: boolean; available?: boolean }
export function engagementMode(connection: Pick<ConnectionHandle, 'rpc'>, signal: AbortSignal) {
  const store = createSnapshotStore<{ snapshot?: Mode; loading: boolean; error?: string }>({ loading: true });
  const source = pollingSource(store, async pollSignal => {
    try {
      const reply = await connection.rpc.call('/api', 'djupleita/mode', {}, pollSignal);
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.value as Mode;
    } catch (error) {
      if (error instanceof Error && error.message.endsWith('djupleita/mode: HTTP 404')) return { enabled: true, available: false };
      throw error;
    }
  });
  return { ...source, async setEnabled(enabled: boolean) {
    const reply = await connection.rpc.call('/api', 'djupleita/mode/update', { enabled }, signal);
    if (!reply.ok) throw new Error(reply.error.message);
    store.set({ snapshot: reply.value as Mode, loading: false });
  } };
}

export function EngagementMode({ mode, children, activeOnly = false, controls = true, openControls }: {
  mode: ReturnType<typeof engagementMode>; children: ReactNode; activeOnly?: boolean; controls?: boolean; openControls?: (() => void) | undefined;
}) {
  const state = useSyncExternalStore(mode.subscribe, mode.getSnapshot);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (activeOnly) return state.snapshot?.enabled ? children : null;
  const enabled = state.snapshot?.enabled;
  const unavailable = state.snapshot?.available === false;
  const compatibility = unavailable && <p role="alert">This server does not provide engagement controls: /api/djupleita/mode returned HTTP 404. Update and restart the server using the same Djupleita release as this interface, then retry. The interface cannot turn off server enforcement without these controls.<br /><button type="button" className={panelCss.button} onClick={() => { void mode.refresh(); }}>Retry engagement status</button></p>;
  const failure = state.error && <p role="alert">{state.error}<br /><button type="button" className={panelCss.button} onClick={() => { void mode.refresh(); }}>Retry engagement status</button></p>;
  if (!controls) return enabled ? <>{compatibility}{failure}{children}</> : <section className={css.controls}>
    <p role="status">{enabled === undefined ? 'Loading engagement mode…' : 'The Djupleita engagement layer is off.'}</p>
    {failure}
    <button type="button" className={panelCss.button} onClick={openControls}>Open shared engagement controls</button>
  </section>;
  return <div className={css.gate}>
    <section className={css.controls} aria-label="Engagement mode">
      <h3>Djupleita engagement layer</h3>
      <p role="status">{unavailable ? 'Engagement status cannot be confirmed on this server.' : enabled === undefined ? 'Loading engagement mode…' : enabled ? 'ON · Pentest tools, policy, budgets and evidence recording are active.' : 'OFF · Basic DSH behavior. Pentest tools, policy, budgets and evidence recording are inactive.'}</p>
      <button type="button" className={panelCss.button} disabled={busy || enabled === undefined || unavailable}
        onClick={() => { setBusy(true); setError(''); void mode.setEnabled(!enabled).catch(reason => setError(reason instanceof Error ? reason.message : String(reason))).finally(() => setBusy(false)); }}>
        {unavailable ? 'Engagement switch unavailable' : enabled === false ? 'Turn on engagement layer' : 'Turn off engagement layer'}
      </button>
      <p>Switching off keeps your saved scope, identities and evidence. DSH’s own permissions remain active.</p>
      {compatibility}
      {error && <p role="alert">{error}</p>}
      {failure}
    </section>
    <div className={css.content}>{enabled && children}</div>
  </div>;
}
