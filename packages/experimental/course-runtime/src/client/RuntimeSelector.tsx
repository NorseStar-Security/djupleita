/** Workspace navigation changes the complete browser client generation by changing its mount. */
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PageState } from './model.ts'
import { isolatedReady } from './navigation.ts'
import css from './style.module.css'

/** Pure runtime selection props. */
export interface Selection {
  selected: 'local' | 'course'
  select: (runtime: 'local' | 'course') => void
  hooks: { course: SnapshotStore<PageState> }
}
/** Render the first-party runtime selector above the workspace browser. */
export function RuntimeSelector(props: InjectFace<Selection> & PropsLocale<'course.runtime'>) {
  const ready = props.useCourse(isolatedReady)
  return <div>
    <label className={css.selector}>{props.t('runtime')}<select aria-label={props.t('runtime')} value={props.selected} onChange={(event) => { props.select(event.target.value === 'course' ? 'course' : 'local') }}>
      <option value="local">{props.t('local')}</option><option value="course" disabled={!ready}>{props.t('isolated')}</option>
    </select></label>
    {!ready ? <p role="status" className={css.readiness}>{props.t('notReady')}</p> : null}
  </div>
}
