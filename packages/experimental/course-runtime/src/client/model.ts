/** Browser controller for native management; independent of the selected backend's RPC connection. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CourseAction, CourseDraft, CourseView } from '../types.ts'
import { format, get, parse, put, scopeFields, reconFields, type Field } from './fields.ts'

/** Observable projection consumed by both pages. */
export interface PageState extends SettingsFormShell {
  view?: CourseView
  edits: Record<string, string>
  errors: Record<string, boolean>
  error?: string
  confirming: boolean
}
/** Registration-side actions, bound to framework hooks at the slot boundary. */
export interface PageFace {
  hooks: { course: SnapshotStore<PageState> }
  fieldText: (field: Field) => string
  edit: (path: string, text: string) => void
  reset: (field: Field) => void
  discard: () => void
  save: () => void
  action: (action: CourseAction['action'], confirmed?: boolean) => void
  confirm: (value: boolean) => void
  refresh: () => void
  include: (host: string) => void
}

/** One editor's staged settings; leaving its page discards only unsaved values. */
export class PageModel {
  /** Observable staged form state, independent of backend RPC. */
  readonly store = createSnapshotStore<PageState>({
    available: false, writable: true, dirty: false, invalid: false, saving: false, failed: false,
    edits: {}, errors: {}, confirming: false,
  })
  private readonly lifetime = new AbortController()
  private timer: ReturnType<typeof setTimeout> | undefined
  private refreshing = false
  constructor(private readonly management: string) { void this.refresh() }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const response = await fetch(`${this.management}course-runtime/${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: this.lifetime.signal,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const result: unknown = await response.json()
    if (!response.ok) {
      const error = result !== null && typeof result === 'object' && 'error' in result ? result.error : undefined
      throw new Error(typeof error === 'string' ? error : `Management request failed (${response.status})`)
    }
    return result
  }
  /** Poll only the native host, including while Protected owns the research client. */
  async refresh(): Promise<void> {
    const cancelled = (): boolean => this.lifetime.signal.aborted
    if (this.refreshing || cancelled()) return
    this.refreshing = true
    clearTimeout(this.timer)
    try {
      const view = await this.request('status') as CourseView
      if (cancelled()) return
      this.store.update((state) => {
        // Preserve the editor's revision while it has edits; the host rejects a stale save.
        if (state.view && (state.dirty || view.draft.revision < state.view.draft.revision)) view.draft = state.view.draft
        state.view = view; state.available = true
        state.writable = !['preparing', 'starting', 'stopping'].includes(view.runtime.phase)
      })
    } catch (error) {
      if (!cancelled()) this.store.update((state) => {
        state.available = false; state.error = String(error); state.failed = true
      })
    } finally {
      this.refreshing = false
      if (!cancelled()) this.timer = setTimeout(() => { void this.refresh() }, 2500)
    }
  }
  private edit(path: string, text: string): void {
    const field = [...scopeFields, ...reconFields].find(row => row.path === path)
    if (!field) return
    let invalid = false
    try { parse(field, text) } catch { invalid = true }
    this.store.update((state) => {
      state.edits[path] = text; state.errors[path] = invalid; state.dirty = true
      state.invalid = Object.values(state.errors).some(Boolean); state.failed = false; delete state.error
    })
  }
  private discard(): void {
    this.store.update((state) => {
      state.edits = {}; state.errors = {}; state.dirty = false; state.invalid = false
      state.failed = false; delete state.error; state.confirming = false
    })
    void this.refresh()
  }
  private async save(): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.view || state.invalid || state.saving) return
    this.store.update((s) => { s.saving = true; s.failed = false })
    try {
      const config = structuredClone(state.view.draft.config)
      for (const field of [...scopeFields, ...reconFields]) {
        const text = state.edits[field.path]
        if (text !== undefined) put(config, field.path, parse(field, text))
      }
      const draft = await this.request('draft', { revision: state.view.draft.revision, config }) as CourseDraft
      this.store.update((s) => { if (s.view) s.view.draft = draft })
      this.discard()
    } catch (error) { this.store.update((s) => { s.failed = true; s.error = error instanceof Error ? error.message : String(error) }) }
    finally { this.store.update((s) => { s.saving = false }); await this.refresh() }
  }
  private async action(action: CourseAction['action'], confirmed = false): Promise<void> {
    const state = this.store.getSnapshot()
    if (!state.view || state.dirty) return
    if (state.view.runtime.phase === 'running' && !confirmed) { this.store.update((s) => { s.confirming = true }); return }
    try {
      this.store.update((s) => { s.saving = true; s.confirming = false; delete s.error })
      await this.request('action', { action, revision: state.view.draft.revision, stopConfirmed: confirmed })
    } catch (error) { this.store.update((s) => { s.error = error instanceof Error ? error.message : String(error) }) }
    finally { this.store.update((s) => { s.saving = false }); await this.refresh() }
  }
  /** Build the pure component face.
   * @returns Bound form actions and its observable store. */
  face(): PageFace {
    return {
      hooks: { course: this.store }, fieldText: (field) => {
        const state = this.store.getSnapshot()
        return state.edits[field.path] ?? (state.view ? format(field, get(state.view.draft.config, field)) : '')
      }, edit: (path, text) => { this.edit(path, text) }, reset: (field) => {
        const view = this.store.getSnapshot().view
        if (view) this.edit(field.path, format(field, get(view.defaults, field)))
      }, discard: () => { this.discard() }, save: () => { void this.save() },
      action: (action, confirmed) => { void this.action(action, confirmed) },
      confirm: (value) => { this.store.update((s) => { s.confirming = value }) },
      refresh: () => { void this.refresh() }, include: (host) => {
        const field = scopeFields.find(f => f.path === 'policy.infrastructure')
        if (!field) return
        const rules: unknown = JSON.parse(this.face().fieldText(field))
        if (rules === null || typeof rules !== 'object' || Array.isArray(rules)) return
        const suggestion = host === 'api.openai.com' ? { methods: ['GET', 'POST'], paths: ['/v1/models', '/v1/chat/completions', '/v1/responses'] }
          : { methods: ['GET'], paths: host === 'crt.sh' ? ['/'] : ['/cdx/search/cdx'] }
        const previous: unknown = Reflect.get(rules, host)
        const methods: unknown = previous !== null && typeof previous === 'object' ? Reflect.get(previous, 'methods') : undefined
        const paths: unknown = previous !== null && typeof previous === 'object' ? Reflect.get(previous, 'paths') : undefined
        Reflect.set(rules, host, {
          methods: [...new Set([...(Array.isArray(methods) ? methods.filter((v): v is string => typeof v === 'string') : []), ...suggestion.methods])],
          paths: [...new Set([...(Array.isArray(paths) ? paths.filter((v): v is string => typeof v === 'string') : []), ...suggestion.paths])],
        })
        this.edit(field.path, JSON.stringify(rules, null, 2))
      },
    }
  }
  /** Stop native polling on plugin disposal. */
  dispose(): void { this.lifetime.abort(); clearTimeout(this.timer) }
}
