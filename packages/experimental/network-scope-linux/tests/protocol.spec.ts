import { describe, expect, it } from 'vitest'
import { decodeInspection } from '../src/protocol.ts'

const value = () => ({ protocol: 1, instance: 'fixture', policyHash: 'a'.repeat(64), boundary: 'linux-netns-nftables', uid: 1000,
  healthy: true, allowed: true, policy: { domains: ['acme.test'] }, firstSeq: 0, nextSeq: 0, events: [] })

describe('gateway observation validation', () => {
  it('detaches and freezes policy and validates contiguous records', () => {
    const input = value()
    const output = decodeInspection(input, undefined)
    input.policy.domains.push('widgets.test')
    expect(output.policy).toEqual({ domains: ['acme.test'] })
    expect(Object.isFrozen(output.policy)).toBe(true)
    expect(decodeInspection({ ...value(), nextSeq: 1, events: [{ seq: 0, time: 'fixture', policy: 'a'.repeat(64), event: 'denied' }] }, 0).events).toHaveLength(1)
  })
  it.each([
    null, {}, { ...value(), protocol: 2 }, { ...value(), uid: 0 }, { ...value(), healthy: 'true' },
    { ...value(), policyHash: 'not-a-digest' }, { ...value(), firstSeq: -1 }, { ...value(), firstSeq: 1 },
    { ...value(), nextSeq: 0.5 }, { ...value(), policy: [] }, { ...value(), policy: { bad: undefined } },
    { ...value(), nextSeq: 1 }, { ...value(), nextSeq: 1, events: [null] },
    { ...value(), nextSeq: 1, events: [{ seq: 0, time: 'fixture', event: 'denied', policy: 'b'.repeat(64) }] },
  ])('rejects malformed or incomplete observations %#', (input) => {
    expect(() => decodeInspection(input, 0)).toThrow(expect.objectContaining({ code: 'SCOPE_INVALID_RESPONSE' }))
  })
  it('distinguishes overwritten cursors from future cursors', () => {
    expect(() => decodeInspection({ ...value(), firstSeq: 1, nextSeq: 1 }, 0)).toThrow(expect.objectContaining({ code: 'SCOPE_AUDIT_GAP' }))
    expect(() => decodeInspection(value(), 1)).toThrow(expect.objectContaining({ code: 'SCOPE_INVALID_RESPONSE' }))
  })
})
