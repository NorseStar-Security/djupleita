/** Scope judge, model-readable policy, and Session audit consumers of ctx.networkScope. */
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { NetworkScopeError } from '@deepseek-ai/dsh-experimental-network-scope'
import type { ScopeInspection, ScopeTarget } from '@deepseek-ai/dsh-experimental-network-scope/types'
import { appendPluginRecord, type Session } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'
import './types.ts'

/** Cordis identity of the scope judge and audit consumer. */
export const name = 'experimental-network-scope-guard'
/** No optional services or hidden dependencies. */
export const inject = ['networkScope', 'tools', 'sessions']

/** Structured target extraction; opaque tools remain available behind network enforcement. */
export interface Config {
  /** Background health and audit inspection interval in milliseconds. */
  pollIntervalMs: number
  /** Structured HTTP tools to inspect before dispatch; other capabilities remain open behind external enforcement. */
  targetTools: {
    /** Exact model-visible tool name, including any MCP provider prefix. */
    name: string
    /** Required top-level string argument containing the HTTP(S) target URL. */
    urlField: string
    /** Top-level string argument containing the method; an absent argument means GET. */
    methodField: string
  }[]
}

/** Polling budget and explicit HTTP target argument mappings. */
export const Config: z<Config> = z.object({
  pollIntervalMs: z.natural().min(1).max(2_147_483_647).default(1000),
  targetTools: z.array(z.object({ name: z.string().min(1), urlField: z.string().min(1), methodField: z.string().min(1) })).default([
    { name: 'web_fetch', urlField: 'url', methodField: 'method' },
    { name: 'browser_navigate', urlField: 'url', methodField: 'method' },
    { name: 'mcp__playwright-mcp__browser_navigate', urlField: 'url', methodField: 'method' },
  ]),
})

/** Mount lifecycle-owned inspections, monotonic dispatch guard, and log-only audit records. */
export function apply(ctx: Context, config: Config): void {
  const lifetime = new AbortController()
  const permits = new WeakMap<Readonly<ToolExecution>, string | undefined>()
  const announced = new WeakSet<Session>()
  const mappings = new Map(config.targetTools.map(value => [value.name, value]))
  if (mappings.size !== config.targetTools.length) throw new Error('network scope targetTools contains duplicate names')
  let cursor: number | undefined
  let latest: ScopeInspection | undefined
  let terminalFailure: NetworkScopeError | undefined
  let tail: Promise<unknown> = Promise.resolve()
  let degraded = false

  const unavailable = (error: unknown): void => {
    if (lifetime.signal.aborted) return
    if (error instanceof NetworkScopeError && ['SCOPE_CHANGED', 'SCOPE_AUDIT_GAP', 'SCOPE_INVALID_RESPONSE'].includes(error.code)) {
      terminalFailure = error
    }
    if (!degraded) {
      degraded = true
      const code = error instanceof NetworkScopeError ? error.code : 'SCOPE_UNAVAILABLE'
      ctx.logger.error(`Network scope unavailable (${code}); tool dispatch is blocked. Ask the instructor to restore the gateway; reload after integrity or audit loss.`)
      for (const session of ctx.sessions.list()) {
        try { appendPluginRecord(session, 'plugin:network-scope-guard/unavailable', { code }) } catch (cause) {
          terminalFailure = new NetworkScopeError('SCOPE_UNAVAILABLE', { cause })
          ctx.logger.error('Network scope audit could not be recorded; reload only after the instructor restores Session storage.')
        }
      }
    }
  }

  // One cursor owner serializes polls and preflights. No async feed can consume
  // events behind another reader or append after disposal has completed.
  const refresh = (targets: readonly ScopeTarget[], signal: AbortSignal): Promise<ScopeInspection> => {
    const task = tail.then(async () => {
      const combined = AbortSignal.any([signal, lifetime.signal])
      combined.throwIfAborted()
      if (terminalFailure !== undefined) throw terminalFailure
      const inspection = await ctx.networkScope.inspect(cursor, targets, combined)
      combined.throwIfAborted()
      if (!inspection.healthy) throw new NetworkScopeError('SCOPE_UNAVAILABLE')
      try {
        for (const session of ctx.sessions.list()) {
          if (!announced.has(session)) {
            appendPluginRecord(session, 'plugin:network-scope-guard/boundary', {
              instance: inspection.instance, policyHash: inspection.policyHash, boundary: inspection.boundary, attribution: 'shared-environment',
            })
            announced.add(session)
          }
          for (const event of inspection.events) appendPluginRecord(session, 'plugin:network-scope-guard/network', {
            instance: inspection.instance, attribution: 'shared-environment', event,
          })
        }
      } catch (cause) {
        terminalFailure = new NetworkScopeError('SCOPE_UNAVAILABLE', { cause })
        throw terminalFailure
      }
      cursor = inspection.nextSeq
      latest = inspection
      degraded = false
      return inspection
    })
    tail = task.catch((error: unknown) => {
      // Storage/reporting failure must also disable dispatch. A log failure is
      // not recoverable by silently advancing this environment's audit cursor.
      if (!signal.aborted) unavailable(error)
    })
    return task
  }

  ctx.tools.guard(exec => degraded || terminalFailure !== undefined ? 'Network scope is unavailable; tool dispatch is blocked.'
    : permits.has(exec) ? permits.get(exec) : 'Network scope preflight did not complete; tool dispatch is blocked.')
  ctx.on('tools/pre-execute', async (exec, next) => {
    const mapping = mappings.get(exec.name)
    const args = exec.arguments
    const object = typeof args === 'object' && args !== null ? args as Record<string, unknown> : undefined
    const url = mapping === undefined ? undefined : object?.[mapping.urlField]
    const method = mapping === undefined ? undefined : object?.[mapping.methodField] ?? 'GET'
    const invalid = mapping !== undefined && (typeof url !== 'string' || typeof method !== 'string')
    let code: 'SCOPE_READY' | 'SCOPE_DENIED' | 'SCOPE_INVALID_TARGET' | 'SCOPE_UNAVAILABLE' = 'SCOPE_READY'
    try {
      const targets = mapping !== undefined && typeof url === 'string' && typeof method === 'string' ? [{ url, method }] : []
      const inspection = await refresh(targets, exec.signal)
      if (invalid) code = 'SCOPE_INVALID_TARGET'
      else if (!inspection.allowed) code = 'SCOPE_DENIED'
    } catch {
      code = 'SCOPE_UNAVAILABLE'
    }
    const allowed = code === 'SCOPE_READY'
    const reason = allowed ? undefined : `Network scope denied tool dispatch (${code}); inspect scope_status or ask the instructor to restore the boundary.`
    permits.set(exec, reason)
    if (exec.agent !== undefined) {
      try {
        appendPluginRecord(exec.agent.session, 'plugin:network-scope-guard/judge', { callId: exec.callId, tool: exec.name, allowed, code })
      } catch (cause) {
        terminalFailure = new NetworkScopeError('SCOPE_UNAVAILABLE', { cause })
        unavailable(terminalFailure)
      }
    }
    return next()
  })

  ctx.tools.register(defineTool({
    name: 'scope_status', description: 'Read the instructor-enforced domain/IP policy and network boundary identity. This cannot change scope or grant permissions.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() {
      if (latest === undefined) return Promise.reject(new NetworkScopeError('SCOPE_UNAVAILABLE'))
      return Promise.resolve(JSON.stringify({
        instance: latest.instance, policyHash: latest.policyHash, boundary: latest.boundary, policy: latest.policy,
      }))
    },
  }))

  const polling = (async () => {
    for (;;) {
      try {
        await delay(config.pollIntervalMs, undefined, { signal: lifetime.signal })
        await refresh([], lifetime.signal)
      } catch (error) {
        if (lifetime.signal.aborted) return
        unavailable(error)
      }
    }
  })()
  ctx.effect(() => async () => {
    lifetime.abort()
    await polling
    await tail
  })
}
