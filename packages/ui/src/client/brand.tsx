/** Djupleita's occupants for the harness's public brand slots. */
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import css from './Panel.module.css';

function Mark({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="30" height="30" rx="9" fill="#173a31" />
    <path d="M10 8h5a8 8 0 0 1 0 16h-5V8Zm4 4v8h1a4 4 0 0 0 0-8h-1Z" fill="#8fe0bd" />
    <path d="m23 5 4 4-4 4" stroke="#8fe0bd" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}

export function registerBrand(ctx: Context): void {
  ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, Mark));
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' },
    () => <span className={css.brandName}>Djupleita</span>));
  ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Mark));
}
