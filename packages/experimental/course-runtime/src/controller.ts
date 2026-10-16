/** Instructor-owned durable settings and bounded Docker operation lifecycle. */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import z from '@deepseek-ai/schemastery'
import ScopeProvider from '@deepseek-ai/dsh-experimental-network-scope-linux'
import * as ScopeGuard from '@deepseek-ai/dsh-experimental-network-scope-guard'
import ReconProvider from '@deepseek-ai/dsh-experimental-recon-projectdiscovery'
import type { CourseAction, CourseConfiguration, CourseDraft, CourseRuntimeState, CourseView } from './types.ts'
import type { NativeFeatures } from './features.ts'

/** Host deployment locations, never accepted from browser operation bodies. */
export interface RuntimeOptions {
  sourceRoot: string
  stateRoot: string
  dockerContext: string
  python: string
  operationTimeoutMs: number
}

/** Parse one persisted or wire JSON object without admitting executable values. */
function object(value: unknown): Record<string, JsonValue> {
  if (!isJsonValue(value) || value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Expected a JSON object')
  return value as Record<string, JsonValue>
}

/** Schemastery's runtime resolver accepts unknown input at this validation boundary. */
function validate<S, T>(schema: z<S, T>, value: unknown): T { return z.resolve(value, schema, {})[0] as T }

/** Own one native-host deployment; the research plugin never constructs this object. */
export class RuntimeController {
  /** Native archive failure projected to management without exposing research content. */
  trajectoryError: boolean | undefined
  private operation: Promise<void> | undefined
  private writes: Promise<unknown> = Promise.resolve()
  private readonly lifetime = new AbortController()
  private initializing: Promise<void> | undefined
  private recon = false
  private closed = false
  private readonly children = new Set<ChildProcess>()

  /**
   * @param options - trusted native deployment locations and operation deadline.
   * @param publicUrl - native browser origin used for the protected proxy mount.
   * @param features - Capture selected native features and gateway-only credentials; mandatory local collection is checked before apply.
   */
  constructor(private readonly options: RuntimeOptions, private readonly publicUrl: string,
    private readonly features?: (configuration: CourseConfiguration) => Promise<NativeFeatures>) {}

  /** Register the recon bundle without conflating its presence with a running provider.
   * @param enabled - Whether the bundle is mounted. */
  setReconEnabled(enabled: boolean): void { this.recon = enabled }

  /** Initialize persisted state and stop an interrupted transition before serving controls. */
  initialize(): Promise<void> {
    this.initializing ??= (async () => {
      await mkdir(this.options.stateRoot, { recursive: true, mode: 0o700 })
      try { await this.draft() } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        await this.persist({ revision: 0, config: await this.defaults() })
      }
      await this.command('recover')
    })()
    return this.initializing
  }

  /** Read deployment defaults from the owning schemas and course policy.
   * @returns The schema-owned initial configuration. */
  async defaults(): Promise<CourseConfiguration> {
    const recon: unknown = ReconProvider.Config()
    return { policy: object(JSON.parse(await readFile(join(this.options.sourceRoot, 'course/scope-runtime/scope.json'), 'utf8'))),
      provider: ScopeProvider.Config(), guard: ScopeGuard.Config(), recon: object(recon), forwardOpenAIKey: false,
      actionReview: object(JSON.parse(await readFile(join(this.options.sourceRoot, 'course/scope-runtime/review.json'), 'utf8'))) }
  }

  /** Read and validate durable settings.
   * @returns The last explicitly saved draft and revision. */
  async draft(): Promise<CourseDraft> {
    const value = object(JSON.parse(await readFile(join(this.options.stateRoot, 'draft.json'), 'utf8')))
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new TypeError('Invalid course settings revision')
    return { revision: Number(value.revision), config: this.configuration(value.config) }
  }

  /** Resolve the existing provider schemas at the browser/persistence input.
   * @param value - Untrusted configuration JSON.
   * @returns Validated provider configuration; invalid inputs throw. */
  configuration(value: unknown): CourseConfiguration {
    const input = object(value)
    if (typeof input.forwardOpenAIKey !== 'boolean' || !isJsonValue(input.policy)) throw new TypeError('Invalid course configuration')
    const policy = input.policy
    if (policy === undefined) throw new TypeError('Missing scope policy')
    const recon: unknown = validate(ReconProvider.Config, input.recon)
    const guard = validate(ScopeGuard.Config, input.guard)
    if (new Set(guard.targetTools.map(row => row.name)).size !== guard.targetTools.length) throw new TypeError('Duplicate target tool names')
    return { policy, provider: validate(ScopeProvider.Config, input.provider), guard,
      recon: object(recon), forwardOpenAIKey: input.forwardOpenAIKey,
      ...(input.actionReview === undefined ? {} : { actionReview: object(input.actionReview) }) }
  }

  /** Validate scope through the gateway's canonical parser, then atomically save one revision.
   * @param revision - Draft revision read by the editor.
   * @param input - Complete staged configuration.
   * @returns The newly saved pending revision. */
  save(revision: number, input: unknown): Promise<CourseDraft> {
    return this.exclusive(async () => {
      if (this.operation !== undefined) throw new Error('A runtime operation is in progress; wait before saving')
      const before = await this.draft()
      if (revision !== before.revision) throw new Error('Settings changed in another editor; reload before saving')
      const config = this.configuration(input)
      await this.command('validate', { config, complete: false })
      const next = { revision: before.revision + 1, config }
      await this.persist(next)
      return next
    })
  }

  /** Validate a staged configuration without saving or changing running research.
   * @param input - Complete untrusted staged configuration.
   * @returns Validated configuration and the canonical gateway policy hash. */
  async validate(input: unknown): Promise<{ config: CourseConfiguration; policyHash: string }> {
    const config = this.configuration(input)
    const result = object(JSON.parse(await this.command('validate', { config, complete: false })))
    if (typeof result.policyHash !== 'string') throw new Error('Policy validator omitted its hash')
    return { config, policyHash: result.policyHash }
  }

  private async persist(draft: CourseDraft): Promise<void> {
    const path = join(this.options.stateRoot, 'draft.json')
    await writeFile(`${path}.tmp`, `${JSON.stringify(draft, null, 2)}\n`, { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }

  /** Read live status; no credentials from the private backend descriptor are projected.
   * @returns Saved, applied and live observations for configuration pages. */
  async view(): Promise<CourseView> {
    await this.initialize()
    const [draft, defaults, status, versions] = await Promise.all([this.draft(), this.defaults(), this.command('status'),
      readFile(join(this.options.sourceRoot, 'course/scope-runtime/recon-versions.json'), 'utf8')])
    const runtime = this.state(JSON.parse(status))
    const applied = await this.optionalJson('applied.json')
    const installedVersions = await this.optionalJson('versions.json')
    return { draft, defaults, runtime, reconEnabled: this.recon, openAIKeyAvailable: Boolean(process.env.OPENAI_API_KEY),
      ...(applied ? { applied: { revision: Number(applied.revision), config: this.configuration(applied.config) } } : {}),
      versions: object(JSON.parse(versions)), ...(installedVersions ? { installedVersions } : {}),
      activity: runtime.phase === 'running' ? await this.activity() : [],
      ...(this.trajectoryError === undefined ? {} : { trajectoryError: this.trajectoryError }) }
  }

  private async optionalJson(name: string): Promise<Record<string, JsonValue> | undefined> {
    try { return object(JSON.parse(await readFile(join(this.options.stateRoot, name), 'utf8'))) }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
  }

  /** Validate a runtime transition before launching its owned asynchronous operation.
   * @param request - Explicit revision-fenced browser action. */
  start(request: CourseAction): Promise<void> {
    return this.exclusive(async () => {
      if (this.closed || this.operation !== undefined) throw new Error('A runtime operation is already in progress')
      const draft = await this.draft()
      if (request.revision !== draft.revision) throw new Error('Settings changed; refresh before applying')
      const current = (await this.view()).runtime
      if (current.phase === 'running' && !request.stopConfirmed) throw new Error('Protected research is running. Choose Stop and apply or Stop first.')
      if (request.action === 'apply') await this.command('validate', { config: draft.config, complete: true })
      const features = request.action === 'apply' ? await this.features?.(draft.config) : undefined
      if (request.action === 'apply' && features?.trajectories !== true) throw new Error('Isolated research requires the local trajectory collector and projection plugins. Enable them before applying.')
      const task = this.command(request.action, { ...draft, publicUrl: `${this.publicUrl}runtimes/course/`, reconEnabled: this.recon,
        ...(features === undefined ? {} : { features }) })
        .then(() => undefined)
      this.operation = task
      // The durable status file owns operation failure display; observing the promise prevents an unhandled rejection.
      void task.catch(() => undefined).finally(() => { if (this.operation === task) this.operation = undefined })
      await delay(50)
    })
  }

  /** Refuse profile changes that could unload active runtime management. */
  async assertStopped(): Promise<void> {
    const state = (await this.view()).runtime
    if (this.operation !== undefined || !(state.phase === 'stopped' || state.phase === 'failed' && state.researchStopped === true)) throw new Error('Stop the protected runtime in Network Scope before disabling or removing this plugin.')
  }

  /** Read the research process's activity summary through its separate authenticated transport.
   * @returns Affected sessions and process activity, or an explicit inspection error. */
  async activity(): Promise<string[]> {
    try {
      const response = await this.backendFetch('/course-runtime/activity')
      if (!response.ok) throw new Error(`Research activity returned ${response.status}`)
      const value: unknown = await response.json()
      if (!Array.isArray(value) || !value.every(row => typeof row === 'string')) throw new TypeError('Invalid research activity response')
      return value
    } catch (error) { return [`Activity inspection unavailable: ${error instanceof Error ? error.message : String(error)}. Applying stops all research processes.`] }
  }

  /** Read private relay coordinates; never return these from the management API.
   * @returns Loopback relay coordinates and its private launch token. */
  async backend(): Promise<{ origin: string; token: string }> {
    const value = object(JSON.parse(await readFile(join(this.options.stateRoot, 'backend.json'), 'utf8')))
    if (typeof value.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(value.origin) || typeof value.token !== 'string') throw new TypeError('Invalid protected backend descriptor')
    return { origin: value.origin, token: value.token }
  }

  private cookie: { token: string; value: string } | undefined

  /** Obtain only the protected backend's browser cookie; native credentials never travel upstream.
   * @returns The protected relay origin and its separate authentication cookie. */
  async backendCookie(): Promise<{ origin: string; cookie: string }> {
    const backend = await this.backend()
    if (this.cookie?.token !== backend.token) {
      const response = await fetch(`${backend.origin}/?token=${encodeURIComponent(backend.token)}`, {
        redirect: 'manual', signal: AbortSignal.timeout(10000),
      })
      const value = response.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
      if (response.status !== 303 || !value) throw new Error('Protected backend authentication failed')
      this.cookie = { token: backend.token, value }
    }
    return { origin: backend.origin, cookie: this.cookie.value }
  }

  private async backendFetch(path: string): Promise<Response> {
    const backend = await this.backendCookie()
    return fetch(`${backend.origin}${path}`, { headers: { cookie: backend.cookie }, signal: AbortSignal.timeout(5000) })
  }

  /** Read a bounded persisted-record page using only the private research credential.
   * @param query - session page or record offsets selected by the native archive poller.
   * @returns parsed untrusted JSON; the archive validates records before committing. */
  async archive(query: URLSearchParams): Promise<unknown> {
    const response = await this.backendFetch(`/course-runtime/archive?${query}`)
    if (!response.ok || response.body === null) throw new Error('Protected archive read failed')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2 * 1024 * 1024) throw new Error('Protected archive page exceeds its byte limit')
        chunks.push(value)
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      return value
    } finally { await reader.cancel(); reader.releaseLock() }
  }

  /** Renew the gateway-only lease after native intake durably accepted a complete poll.
   * @param deployment - identity observed before reading the records; never authorizes a newer deployment. */
  async renewArchiveLease(deployment: { revision: number; policyHash: string; reviewHash: string }): Promise<void> {
    await this.command('archive-ready', deployment)
  }

  /** Fail closed if mandatory local intake fails; the durable lifecycle owns stop confirmation. */
  async stopForArchiveFailure(): Promise<void> {
    this.trajectoryError = true
    await this.exclusive(async () => {
      if (this.operation !== undefined) return
      await this.command('stop')
    })
  }

  private state(value: unknown): CourseRuntimeState {
    const row = object(value)
    if (typeof row.phase !== 'string' || !['stopped', 'preparing', 'starting', 'stopping', 'running', 'failed'].includes(row.phase)) throw new TypeError('Invalid course runtime phase')
    if (row.appliedRevision !== undefined && !Number.isSafeInteger(row.appliedRevision)) throw new TypeError('Invalid applied revision')
    return { phase: row.phase as CourseRuntimeState['phase'], prepared: row.prepared === true, healthy: row.healthy === true,
      researchStopped: row.researchStopped === true,
      ...(typeof row.appliedRevision === 'number' ? { appliedRevision: row.appliedRevision } : {}),
      ...(typeof row.policyHash === 'string' ? { policyHash: row.policyHash } : {}),
      ...(typeof row.actionReviewReady === 'boolean' ? { actionReviewReady: row.actionReviewReady } : {}),
      ...(typeof row.reviewHash === 'string' ? { reviewHash: row.reviewHash } : {}),
      ...(typeof row.detail === 'string' && ['preparing', 'starting', 'stopping'].includes(row.phase) ? { detail: row.detail } : {}),
      ...(typeof row.error === 'string' ? { error: row.error } : {}) }
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.writes.then(run)
    this.writes = next.catch(() => undefined)
    return next
  }

  private command(action: string, value?: unknown): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.python, [join(this.options.sourceRoot, 'course/scope-runtime/manage.py'), action,
        '--state', this.options.stateRoot, '--source', this.options.sourceRoot, '--context', this.options.dockerContext], {
        stdio: ['pipe', 'pipe', 'pipe'], signal: this.lifetime.signal,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PYTHONDONTWRITEBYTECODE: '1',
          ...(action === 'apply' && typeof value === 'object' && value !== null && 'config' in value
            && object(value.config).forwardOpenAIKey === true ? { DSH_COURSE_OPENAI_API_KEY: process.env.OPENAI_API_KEY } : {}) },
      })
      this.children.add(child)
      let stdout = '', stderr = ''
      const timer = setTimeout(() => { child.kill('SIGTERM') }, this.options.operationTimeoutMs)
      child.stdout.on('data', (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-2 * 1024 * 1024) })
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8000) })
      child.on('error', reject)
      child.on('close', (code) => { this.children.delete(child); clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new Error(stderr || `Course runtime ${action} failed (${code})`)) })
      child.stdin.on('error', reject)
      child.stdin.end(value === undefined ? '' : JSON.stringify(value))
    })
  }

  /** Drain an in-progress operation and stop owned containers on native-host teardown. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const child of this.children) child.kill('SIGTERM')
    await this.writes
    await this.operation?.catch(() => undefined)
    await this.command('stop')
    this.lifetime.abort()
  }
}
