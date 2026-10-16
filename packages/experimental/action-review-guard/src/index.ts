/** Mandatory per-dispatch action review independent of general-purpose permission presets. */
import type { Context } from '@deepseek-ai/cordis'
import { ActionReviewError } from '@deepseek-ai/dsh-experimental-action-review'
import '@deepseek-ai/dsh-experimental-network-scope'
import type { ActionReviewDecision, ReviewRequest } from '@deepseek-ai/dsh-experimental-action-review/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { ToolExecution, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import './types.ts'

/** Cordis identity of the mandatory action admission consumer. */
export const name = 'experimental-action-review-guard'
/** Mount as soon as tools exist; missing review/scope providers must not disable the guard. */
export const inject = ['tools']

/** Install per-call review and a root-lifetime denial latch; unload requires a process restart. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const pending = new Set<Promise<void>>()
  const permits = new WeakMap<Readonly<ToolExecution>, ActionReviewDecision>()
  const denials = new WeakMap<Readonly<ToolExecution>, string>()
  const parents = new Map<ToolExecutionToken, ToolCallId>()
  let failed = false

  const fail = (code: string): void => {
    if (failed) return
    failed = true
    lifetime.abort()
    ctx.logger.error(`Action review admission closed (${code}); no further tools may run. Ask the instructor to restore review/storage and restart the process.`)
  }

  ctx.on('internal/service', (name, value: unknown) => {
    if (!lifetime.signal.aborted && ['actionReview', 'networkScope'].includes(name) && value === undefined) fail('ACTION_REVIEW_STOPPED')
  })

  // Unlike ordinary optional policy, unloading a required course guard must
  // not reopen execution. The application root owns this effect; its closed
  // watcher and each registry's latch survive consumer/provider removal and
  // release only on root disposal, including subsequently mounted Tools.
  const admissionOwner = ctx.extend({ fiber: ctx.root.fiber })
  admissionOwner.inject(['tools'], (guarded) => {
    guarded.extend({ fiber: ctx.root.fiber }).tools.guard((exec) => {
      if (lifetime.signal.aborted || failed || ctx.get('actionReview') === undefined || ctx.get('networkScope') === undefined) {
        return 'Action review admission is closed; restore required services and restart the process.'
      }
      if (exec.agent === undefined) return 'Action review denied tool dispatch (ACTION_CONTEXT_REQUIRED); a trusted Session is required.'
      const decision = permits.get(exec)
      return decision?.decision === 'allow' ? undefined : `Action review denied tool dispatch (${decision?.code ?? denials.get(exec) ?? 'ACTION_REVIEW_REQUIRED'}).`
    })
  })

  const review = async (exec: ToolExecution): Promise<void> => {
    const signal = AbortSignal.any([exec.signal, lifetime.signal])
    let decision: ActionReviewDecision | undefined
    let code = 'ACTION_REVIEW_UNAVAILABLE'
    const parentCallId = exec.parent === undefined ? undefined : parents.get(exec.parent)
    parents.set(exec.token, exec.callId)
    try {
      signal.throwIfAborted()
      const reviewer = ctx.get('actionReview')
      const scope = ctx.get('networkScope')
      if (reviewer === undefined || scope === undefined) throw new ActionReviewError('ACTION_REVIEW_UNAVAILABLE')
      const observation = await scope.inspect(undefined, [], signal)
      if (!observation.healthy || !observation.allowed) throw new ActionReviewError('ACTION_REVIEW_UNAVAILABLE')
      const status = await reviewer.status(signal)
      if (status.instance !== observation.instance || status.policyHash !== observation.policyHash) throw new ActionReviewError('ACTION_REVIEW_CHANGED')
      if (!status.ready) throw new ActionReviewError('ACTION_REVIEW_UNAVAILABLE')
      const schema = exec.schema ?? ctx.tools.schemas(exec.agent).find(schema => schema.name === exec.name)
      const request: ReviewRequest = { action: { callId: exec.callId, rootCallId: exec.rootCallId,
        ...parentCallId === undefined ? {} : { parentCallId }, sessionId: exec.agent?.session.id ?? null,
        tool: exec.name, arguments: exec.arguments as JsonValue, ...schema === undefined ? {} : { schema } },
      policyHash: observation.policyHash }
      decision = await reviewer.review(request, signal)
      signal.throwIfAborted()
      if (decision.instance !== status.instance || decision.policyHash !== status.policyHash || decision.reviewHash !== status.reviewHash) {
        throw new ActionReviewError('ACTION_REVIEW_CHANGED')
      }
      code = exec.agent === undefined ? 'ACTION_CONTEXT_REQUIRED' : schema === undefined ? 'ACTION_REVIEW_INPUT' : decision.code
      if (exec.agent !== undefined && schema !== undefined) permits.set(exec, decision)
    } catch (error) {
      code = error instanceof ActionReviewError ? error.code : 'ACTION_REVIEW_UNAVAILABLE'
      if (error instanceof ActionReviewError && ['ACTION_REVIEW_CHANGED', 'ACTION_REVIEW_INVALID_RESPONSE', 'ACTION_REVIEW_AUDIT'].includes(error.code)) fail(code)
    }
    denials.set(exec, code)
    if (exec.agent !== undefined) {
      try {
        appendPluginRecord(exec.agent.session, 'plugin:action-review-guard/decision', { callId: exec.callId, rootCallId: exec.rootCallId,
          ...parentCallId === undefined ? {} : { parentCallId }, tool: exec.name, allowed: permits.get(exec)?.decision === 'allow', code,
          ...decision === undefined ? {} : { review: decision } })
      } catch {
        permits.delete(exec)
        fail('ACTION_REVIEW_AUDIT')
      }
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const task = review(exec)
    pending.add(task)
    try { await task } finally { pending.delete(task) }
    return next()
  }, { prepend: true })

  ctx.on('tools/result', (exec, result) => {
    parents.delete(exec.token)
    if (exec.agent === undefined) return
    const review = permits.get(exec)
    try {
      appendPluginRecord(exec.agent.session, 'plugin:action-review-guard/result', { callId: exec.callId, tool: exec.name,
        isError: result.isError, reviewed: review !== undefined, ...review === undefined ? {} : { receipt: review.receipt } })
    } catch { fail('ACTION_REVIEW_AUDIT') }
  })

  ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled(pending)
    parents.clear()
  })
}
