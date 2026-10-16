import { describe, expect, it } from 'vitest'
import { dnsName, domainRules, inScope, targetDomain } from '../src/domain.ts'

describe('domain scope identity', () => {
  it.each([
    ['https://EXAMPLE.test.:443/a?q=b#c', 'example.test'],
    ['example.test:8443', 'example.test'],
    ['bücher.test', 'xn--bcher-kva.test'],
    ['https://bücher.test/', 'xn--bcher-kva.test'],
    ['example。test', 'example.test'],
  ])('normalizes %s to %s', (value, expected) => {
    expect(targetDomain(value)).toBe(expected)
  })

  it.each([
    '', ' ', ' example.test', 'example.test ', 'https://', '//example.test',
    'ftp://example.test', 'file:///example.test', 'javascript:alert(1)',
    'https://example.test@evil.test', 'https://evil.test@example.test',
    'https://example.test\\@evil.test', 'https://example.test\n.evil.test',
    'example.test/path', 'example.test:0', 'example.test:65536', 'example.test:abc',
    '127.0.0.1', '127.1', '2130706433', '0x7f000001', '0x7f.1', 'example.999', 'a.0x1', 'https://127.0.0.1',
    'https://[::1]', '[::1]', 'https://example.test:65536',
    'https://%zz.test', 'bad..test', '-bad.test', 'bad_.test', '*.example.test',
    'example.test..', 'a'.repeat(64) + '.test', 'a.'.repeat(127) + 'test',
  ])('rejects indeterminate or non-domain destination %s', (value) => {
    expect(targetDomain(value)).toBeUndefined()
  })

  it('requires exact matches unless descendants are explicitly authorized', () => {
    const rules = domainRules(['EXAMPLE.test.', '*.lab.test', 'bücher.test'])
    expect(rules).toEqual([
      { domain: 'example.test', descendants: false },
      { domain: 'lab.test', descendants: true },
      { domain: 'xn--bcher-kva.test', descendants: false },
    ])
    for (const host of ['example.test', 'a.lab.test', 'a.b.lab.test', 'xn--bcher-kva.test']) expect(inScope(host, rules)).toBe(true)
    for (const host of ['sub.example.test', 'lab.test', 'evilexample.test', 'example.test.evil.test', 'evillab.test']) expect(inScope(host, rules)).toBe(false)
  })

  it.each([[], ['*'], ['https://example.test'], ['example.test/path'], ['127.0.0.1'], ['**.test'], ['*.'], ['example.test:443']].map(values => ({ values })))('fails loading invalid scope $values', ({ values }) => {
    expect(() => domainRules(values)).toThrow(/scope-judge:/)
  })

  it('rejects URL and encoded syntax where a bare DNS name is required', () => {
    expect(dnsName('%65xample.test')).toBeUndefined()
    expect(dnsName('https://example.test')).toBeUndefined()
  })
})
