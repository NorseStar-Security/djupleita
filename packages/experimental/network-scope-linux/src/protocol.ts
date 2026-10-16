/** Fail-closed decoding of the gateway's versioned, bounded observation. */
import { NetworkScopeError } from '@deepseek-ai/dsh-experimental-network-scope'
import type { ScopeInspection, ScopeNetworkEvent } from '@deepseek-ai/dsh-experimental-network-scope/types'
import { deepFreeze, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }

/**
 * Validate event continuity, immutable identity fields and JSON shape before use.
 * @param input - Untrusted decoded gateway response.
 * @param after - Requested inclusive audit cursor, or undefined for initial attachment.
 * @returns A detached and deeply frozen observation, or throws a typed scope error.
 */
export function decodeInspection(input: unknown, after: number | undefined): ScopeInspection {
  const invalid = () => new NetworkScopeError('SCOPE_INVALID_RESPONSE')
  if (!object(input) || input.protocol !== 1 || typeof input.instance !== 'string' || input.instance.length === 0
    || typeof input.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.policyHash)
    || input.boundary !== 'linux-netns-nftables' || input.uid !== 1000 || typeof input.healthy !== 'boolean'
    || typeof input.allowed !== 'boolean' || !integer(input.firstSeq) || !integer(input.nextSeq)
    || input.firstSeq > input.nextSeq || !Array.isArray(input.events) || !object(input.policy)) throw invalid()
  if (after !== undefined && after < input.firstSeq) throw new NetworkScopeError('SCOPE_AUDIT_GAP')
  if (after !== undefined && after > input.nextSeq) throw invalid()
  const policy = snapshotJsonValue(input.policy)
  if (policy === undefined) throw invalid()
  const events: ScopeNetworkEvent[] = []
  let seq = after ?? input.nextSeq
  const rawEvents: readonly unknown[] = input.events
  for (const event of rawEvents) {
    const copy = snapshotJsonValue(event)
    if (!object(copy) || copy.seq !== seq || typeof copy.time !== 'string' || typeof copy.event !== 'string'
      || copy.policy !== input.policyHash) throw invalid()
    // Explicit fields preserve their narrowed types; the snapshot admits only JSON fields.
    events.push({ ...copy, seq, time: copy.time, event: copy.event, policy: input.policyHash })
    seq++
  }
  if (seq !== input.nextSeq) throw invalid()
  return deepFreeze({ protocol: 1, instance: input.instance, policyHash: input.policyHash,
    boundary: 'linux-netns-nftables', uid: 1000, healthy: input.healthy, policy: policy as JsonValue,
    firstSeq: input.firstSeq, nextSeq: input.nextSeq, events, allowed: input.allowed })
}
