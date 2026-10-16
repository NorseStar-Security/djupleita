/** Dedicated staged Scope and Recon pages. No service context crosses into rendering. */
import { SettingsForm } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { PageFace } from './model.ts'
import { scopeFields, reconFields, type Field } from './fields.ts'
import type { LocaleKey } from './locales.ts'
import css from './style.module.css'

/** Pure renderer props supplied by the slot. */
export type CoursePageProps = PropsRuntime<'plugins.bundle.config'> & PropsLocale<'course.runtime'> & InjectFace<PageFace>

function Page(props: CoursePageProps & { recon: boolean }) {
  const state = props.useCourse(s => s)
  const { t } = props
  if (props.view === 'summary') return t(props.recon ? 'reconDescription' : 'scopeDescription')
  const view = state.view
  const fields = props.recon ? reconFields : scopeFields
  const busy = !state.writable || state.saving
  function field(row: Field) {
    const id = `course-${row.path}`
    const label = t(row.path as LocaleKey)
    return <div className={css.field} key={row.path}>
      <label htmlFor={id}>{label}</label>
      {row.kind === 'boolean' ? <input id={id} type="checkbox" checked={props.fieldText(row) === 'true'} disabled={busy} onChange={(e) => { props.edit(row.path, String(e.target.checked)) }} />
        : row.kind === 'json' || row.kind === 'lines' ? <textarea id={id} rows={row.kind === 'json' ? 5 : 3} value={props.fieldText(row)} disabled={busy} aria-invalid={state.errors[row.path] === true} onChange={(e) => { props.edit(row.path, e.target.value) }} />
          : <input id={id} type={row.kind === 'number' ? 'number' : 'text'} min={row.kind === 'number' ? 1 : undefined} value={props.fieldText(row)} disabled={busy} aria-invalid={state.errors[row.path] === true} onChange={(e) => { props.edit(row.path, e.target.value) }} />}
      {state.errors[row.path] ? <span role="alert">{t('invalid')}</span> : null}
      <button type="button" disabled={busy} onClick={() => { props.reset(row) }}>{t('reset')}</button>
    </div>
  }
  let missing: string[] = []
  if (view && typeof view.draft.config.policy === 'object' && view.draft.config.policy !== null && !Array.isArray(view.draft.config.policy)) {
    const rules = view.draft.config.policy.infrastructure
    missing = ['api.openai.com', 'crt.sh', 'web.archive.org'].filter((host) => {
      const rule = rules && typeof rules === 'object' && !Array.isArray(rules) ? rules[host] : undefined
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return true
      const methods = host === 'api.openai.com' ? ['GET', 'POST'] : ['GET']
      const paths = host === 'api.openai.com' ? ['/v1/models', '/v1/chat/completions', '/v1/responses'] : host === 'crt.sh' ? ['/'] : ['/cdx/search/cdx']
      return !methods.every(method => Array.isArray(rule.methods) && rule.methods.includes(method))
        || !paths.every(path => Array.isArray(rule.paths) && rule.paths.includes(path))
    })
  }
  return <div className={css.page}>
    {state.error ? <p role="alert" className={css.error}>{state.error}</p> : null}
    {view?.trajectoryError ? <p role="alert" className={css.error}>{t('trajectoryError')}</p> : null}
    {view ? <section className={css.status} aria-label={t('phase')}>
      <dl><dt>{t('phase')}</dt><dd>{view.runtime.phase}</dd><dt>{t('saved')}</dt><dd>{view.draft.revision}</dd>
        <dt>{t('applied')}</dt><dd>{view.runtime.appliedRevision ?? t('none')}</dd><dt>{t('enforcement')}</dt><dd>{!state.available ? t('unknown') : view.runtime.healthy ? t('healthy') : t('stopped')}</dd>
        <dt>{t('reviewStatus')}</dt><dd>{!state.available || view.runtime.actionReviewReady === undefined ? t('unknown') : t(view.runtime.actionReviewReady ? 'reviewReady' : 'reviewUnavailable')}</dd>
        <dt>{t('policyHash')}</dt><dd className={css.hash}>{view.runtime.policyHash ?? t('none')}</dd></dl>
      {view.runtime.appliedRevision !== view.draft.revision ? <p>{t('pending')}</p> : null}
      {view.runtime.detail ? <p>{view.runtime.detail}</p> : null}
      {!props.recon ? <details><summary>{t('policySnapshots')}</summary><h4>{t('saved')}</h4><pre>{JSON.stringify(view.draft.config.policy, null, 2)}</pre><h4>{t('applied')}</h4><pre>{view.applied ? JSON.stringify(view.applied.config.policy, null, 2) : t('none')}</pre></details> : null}
      {view.runtime.error ? <p className={css.error} role="alert">{view.runtime.error}</p> : null}
      <div className={css.actions}>
        <button disabled={busy || state.dirty || view.runtime.phase === 'running'} onClick={() => { props.action('prepare') }}>{t('prepare')}</button>
        <button disabled={busy || state.dirty || !view.runtime.prepared} onClick={() => { props.action('apply') }}>{t(view.runtime.phase === 'running' ? 'stopApply' : 'apply')}</button>
        {['running', 'failed'].includes(view.runtime.phase) ? <button disabled={busy} onClick={() => { props.action('stop', true) }}>{t('stop')}</button> : null}
      </div>
      {state.confirming ? <div role="alertdialog" aria-label={t('stopApply')} className={css.confirm}>
        <p>{t('confirm')}</p><strong>{t('affected')}</strong><ul>{view.activity.map((row, index) => <li key={index}>{row}</li>)}</ul>
        <button onClick={() => { props.action('apply', true) }}>{t('stopApply')}</button><button onClick={() => { props.confirm(false) }}>{t('cancel')}</button>
      </div> : null}
    </section> : null}
    <SettingsForm state={state} labels={{ unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }} onSave={props.save} onDiscard={props.discard}>
      {props.recon ? <><p>{t('components')}</p><details><summary>{t(view?.installedVersions ? 'versions' : 'pinnedVersions')}</summary><pre>{JSON.stringify(view?.installedVersions ?? view?.versions, null, 2)}</pre></details></> : <p>{t('key')}</p>}
      {fields.filter(f => !f.advanced).map(field)}
      <details><summary>{t('advanced')}</summary>{fields.filter(f => f.advanced).map(field)}</details>
      {!props.recon ? <section><h3>{t('authorize')}</h3><p>{t('permissions')}</p>{missing.map(host => <p key={host}><code>{host}</code> <button disabled={busy || state.invalid} onClick={() => { props.include(host) }}>{t('include')}</button></p>)}</section> : <p>{t('permissions')}</p>}
    </SettingsForm>
  </div>
}
/** Scope plugin Configure page. */
export function ScopePage(props: CoursePageProps) { return <Page {...props} recon={false} /> }
/** Recon plugin Configure page. */
export function ReconPage(props: CoursePageProps) { return <Page {...props} recon /> }
