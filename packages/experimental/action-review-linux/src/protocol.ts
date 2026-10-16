/** Strict decoding of trusted-service wire responses before they can permit dispatch. */
import { brandNumber, brandString } from '@deepseek-ai/dsh-brand'
import { ActionReviewError } from '@deepseek-ai/dsh-experimental-action-review'
import type { ActionInputHash, ActionReviewDecision, ActionReviewHash, ActionReviewReceipt, ActionReviewStatus, ActionRiskFinding } from '@deepseek-ai/dsh-experimental-action-review/types'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function label(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256 }
function hash(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) }
function invalid(): never { throw new ActionReviewError('ACTION_REVIEW_INVALID_RESPONSE') }

function identity(input: Record<string, unknown>): Omit<ActionReviewStatus, 'ready'> {
  if (input.protocol !== 1 || !label(input.instance) || !hash(input.policyHash) || !hash(input.reviewHash)) invalid()
  return { protocol: 1, instance: input.instance, policyHash: input.policyHash,
    reviewHash: brandString<ActionReviewHash>(input.reviewHash) }
}

/**
 * Decode readiness without treating it as an execution permission.
 * @param input - Untrusted JSON from GET /review/status.
 * @returns A deeply frozen complete observation, or a typed integrity failure.
 */
export function decodeStatus(input: unknown): ActionReviewStatus {
  if (!object(input) || typeof input.ready !== 'boolean') invalid()
  return deepFreeze({ ...identity(input), ready: input.ready })
}

/**
 * Decode a durable receipt and verify it binds the exact submitted bytes and policy.
 * @param input - Untrusted JSON from POST /review.
 * @param inputHash - SHA-256 of the raw submitted UTF-8 body, including the policy identity.
 * @param policyHash - Fresh network policy identity carried by that body.
 * @returns A detached frozen decision; no malformed or mismatched response can authorize execution.
 */
export function decodeDecision(input: unknown, inputHash: string, policyHash: string): ActionReviewDecision {
  if (!object(input)) invalid()
  const deployment = identity(input)
  if (input.inputHash !== inputHash || deployment.policyHash !== policyHash
    || (input.decision !== 'allow' && input.decision !== 'deny')
    || typeof input.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,95}$/.test(input.code)
    || !Number.isSafeInteger(input.receipt) || Number(input.receipt) < 1 || !Array.isArray(input.findings)
    || (input.decision === 'allow' && input.findings.length === 0)) invalid()
  const findings: ActionRiskFinding[] = []
  for (const entry of input.findings) {
    if (!object(entry) || !label(entry.evaluator) || !label(entry.model) || !object(entry.risks)) invalid()
    const risks = Object.create(null) as Record<string, number>
    for (const [key, value] of Object.entries(entry.risks)) {
      if (!label(key) || typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid()
      risks[key] = value
    }
    findings.push({ evaluator: entry.evaluator, model: entry.model, risks })
  }
  return deepFreeze({ ...deployment, inputHash: brandString<ActionInputHash>(inputHash), decision: input.decision,
    code: input.code, findings, receipt: brandNumber<ActionReviewReceipt>(Number(input.receipt)) })
}
