import { describe, expect, it } from 'vitest'
import { reconCapture } from '../src/recon.ts'
import { importRage } from '../src/rage.ts'

const policyHash = 'fixture-policy'
const inventory = (component: string, observations: unknown[]) => ({ component, observations,
  mode: component === 'subfinder' || component === 'urlfinder' ? 'passive' : 'active',
  targets: ['example.test'], policyHash, coverage: 'best-effort', diagnosticsPresent: false })

describe('accepted inventory and graph boundaries', () => {
  it.each([
    ['subfinder', 'domain', 'API.Example.test.', 'api.example.test'],
    ['urlfinder', 'url', 'https://example.test/path?token=secret#fragment', 'https://example.test/path'],
    ['dnsx', 'ip', '2001:0db8::1', '2001:db8::1'],
    ['httpx', 'url', 'https://198.51.100.1/', 'https://198.51.100.1/'],
    ['katana', 'url', 'https://[2001:db8::1]/', 'https://[2001:db8::1]/'],
    ['naabu', 'service', '198.51.100.1', '198.51.100.1'],
  ])('accepts %s inventory without widening its policy', (component, kind, value, expected) => {
    const result = reconCapture(JSON.stringify(inventory(component, [{ kind, value, source: component,
      inScope: false, ...(kind === 'service' ? { port: 443 } : {}) }])), policyHash)
    expect(result.observations[0]).toMatchObject({ value: expected, attributes: { inScopeAtObservation: false } })
    expect(result.policyHash).toBe(policyHash)
    expect(result.coverage).toBe('best-effort')
    if (component === 'httpx' || component === 'katana') {
      expect(result.relationships[0]?.source.kind).toBe('ip')
    }
  })

  it('rejects a changed policy, mixed source and malformed service atomically', () => {
    const rows = [{ kind: 'domain', value: 'example.test', source: 'subfinder', inScope: true }]
    expect(() => reconCapture(inventory('subfinder', rows), 'another-policy')).toThrow('policy')
    expect(() => reconCapture(inventory('dnsx', rows), policyHash)).toThrow('source')
    expect(() => reconCapture(inventory('naabu', [{ kind: 'service', value: '198.51.100.1', source: 'naabu',
      inScope: true }]), policyHash)).toThrow('port')
    expect(reconCapture(inventory('subfinder', []), policyHash).observations).toEqual([])
  })

  it('imports relationships as unvalidated claims and rejects dangling graph references', () => {
    const manifest = { kind: 'manifest', spec_version: '0.1' }
    const nodes = ['one', 'two'].map(name => ({ kind: 'node', node_id: `aws|example|Resource|${name}`, node_type: 'Resource' }))
    const edge = { kind: 'edge', source: nodes[0]?.node_id, target: nodes[1]?.node_id, type: 'CanAccess', nature: 'explicit' }
    const encode = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n')
    const imported = importRage(encode([manifest, ...nodes, edge, { kind: 'future-kind', content: 'ignored' }]))
    expect(imported.observations.every(observation => observation.basis === 'inferred' && observation.confidence === 0)).toBe(true)
    expect(imported.relationships[0]).toMatchObject({ relation: 'x-assessment:ImportedRelationship', originalType: 'CanAccess' })
    expect(() => importRage(encode([manifest, nodes[0], edge]))).toThrow('absent')
    expect(() => importRage(encode([manifest, ...nodes, { ...edge, nature: 'derived' }]))).toThrow('evidence')
    expect(() => importRage(encode([manifest, ...nodes, nodes[0]]))).toThrow('duplicate')
  })
})
