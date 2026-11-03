/** Keep a failed Djupleita view recoverable instead of retiring its DSH slot. */
import { Component } from 'react';
import type { ReactNode } from 'react';
import css from './Panel.module.css';

export class PanelBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  override componentDidCatch(error: unknown): void {
    console.error('Djupleita panel failed to render:', error);
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <section className={css.panelFailure} role="alert" aria-label="Djupleita panel error">
      <h3>Djupleita could not display this panel</h3>
      <p>The panel encountered an error. Your saved scope and settings have not been changed by this display error.</p>
      <p>Reload to try again. Unsaved edits in this panel will need to be entered again. If it fails again, the browser console contains the error details.</p>
      <button type="button" onClick={() => this.setState({ failed: false })}>Reload Djupleita panel</button>
    </section>;
  }
}
