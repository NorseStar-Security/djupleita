import { describe, expect, it } from 'vitest'
import { decodeDecision, decodeStatus } from '../src/protocol.ts'

const policyHash = 'a'.repeat(64)
const reviewHash = 'b'.repeat(64)
const inputHash = 'c'.repeat(64)
const status = { protocol: 1, instance: 'gateway', policyHash, reviewHash, ready: true }
const decision = { protocol: 1, instance: 'gateway', policyHash, reviewHash, inputHash,
  decision: 'allow', code: 'ACTION_ALLOWED', findings: [{ evaluator: 'llm', model: 'fixture-v1', risks: { destructive: 0.1 } }], receipt: 1 }

describe('action reviewer wire values', () => {
  it('detaches and freezes complete status and exact-byte-bound review receipts', () => {
    expect(decodeStatus(status)).toEqual(status)
    expect(decodeStatus({ ...status, ready: false }).ready).toBe(false)
    const source = structuredClone(decision)
    const result = decodeDecision(source, inputHash, policyHash)
    source.findings[0]!.risks.destructive = 0.8
    expect(result).toEqual(decision)
    expect(Object.isFrozen(result.findings[0]?.risks)).toBe(true)
    expect(decodeDecision({ ...decision, decision: 'deny', findings: [] }, inputHash, policyHash).decision).toBe('deny')
  })

  it.each([null, [], {}, { ...status, ready: 1 }, { ...status, protocol: 2 }, { ...status, instance: '' },
    { ...status, instance: 7 }, { ...status, instance: 'x'.repeat(257) }, { ...status, policyHash: 'A'.repeat(64) },
    { ...status, policyHash: 1 }, { ...status, reviewHash: 'broken' }])('rejects incomplete readiness %#', (value) => {
    expect(() => decodeStatus(value)).toThrow(expect.objectContaining({ code: 'ACTION_REVIEW_INVALID_RESPONSE' }))
  })

  it.each([null, [], {}, { ...decision, inputHash: 'd'.repeat(64) }, { ...decision, policyHash: 'd'.repeat(64) },
    { ...decision, decision: 'require_approval' }, { ...decision, code: '' }, { ...decision, code: 3 },
    { ...decision, code: 'lowercase' }, { ...decision, receipt: 0 }, { ...decision, receipt: 0.1 },
    { ...decision, receipt: Number.MAX_SAFE_INTEGER + 1 }, { ...decision, findings: null },
    { ...decision, findings: [] },
    ...[null, [], { evaluator: '', model: 'fixture', risks: {} }, { evaluator: 'llm', model: '', risks: {} },
      { evaluator: 'llm', model: 'fixture', risks: null }, { evaluator: 'llm', model: 'fixture', risks: [] },
      { evaluator: 'llm', model: 'fixture', risks: { '': 0 } }, { evaluator: 'llm', model: 'fixture', risks: { risk: '0' } },
      ...[-1, 1.01, Infinity, NaN].map(risk => ({ evaluator: 'llm', model: 'fixture', risks: { risk } }))]
      .map(finding => ({ ...decision, findings: [finding] }))])('rejects malformed, uncertain or mismatched receipts %#', (value) => {
    expect(() => decodeDecision(value, inputHash, policyHash)).toThrow(expect.objectContaining({ code: 'ACTION_REVIEW_INVALID_RESPONSE' }))
  })

  it('retains prototype-like risk names as data rather than changing object inheritance', () => {
    const input: unknown = JSON.parse(JSON.stringify({ ...decision, findings: [] }).replace('"findings":[]',
      '"findings":[{"evaluator":"custom","model":"v1","risks":{"__proto__":0,"constructor":1}}]'))
    const risks = decodeDecision(input, inputHash, policyHash).findings[0]!.risks
    expect(Object.getPrototypeOf(risks)).toBeNull()
    expect(Object.keys(risks)).toEqual(['__proto__', 'constructor'])
  })
})
