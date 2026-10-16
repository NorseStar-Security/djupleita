import { describe, expect, it } from 'vitest'
import { normalizeTarget, TargetScope } from '../src/scope.ts'
import { argumentsFor, capabilities, observationsFrom } from '../src/components.ts'

const policy = { domains: ['acme.test', '*.acme.test'], ips: ['198.51.100.0/24', '2001:db8::/32'],
  exclude_domains: ['private.acme.test'], exclude_ips: ['198.51.100.9'], infrastructure: { 'api.vendor.test': { methods: ['GET'], paths: ['/'] } } }
const scope = new TargetScope(policy)
const options = { proxy: 'http://127.0.0.1:3128', resolver: '127.0.0.1', rate: 5, concurrency: 2, depth: 2, ports: [80, 443], home: '/tmp/private', sources: { subfinder: ['crtsh'], urlfinder: ['waybackarchive'] }, responseMaxBytes: 1024 }

describe('target grants are not inferred from recon findings', () => {
  it.each(['acme.test', 'app.acme.test', 'https://acme.test/a', '198.51.100.8', '2001:db8::1'])('allows an explicit grant: %s', (target) =>{  expect(scope.allows(target)).toBe(true) })
  it.each(['widgets.test', 'acme.test.widgets.test', 'evilacme.test', 'private.acme.test', '198.51.100.9', '198.51.101.8', '2001:db9::1', 'api.vendor.test'])('rejects an ungranted or excluded target: %s', (target) =>{  expect(scope.allows(target)).toBe(false) })
  it('keeps wildcard apex and raw IP grants separate', () => {
    const wildcard = new TargetScope({ domains: ['*.acme.test'], ips: [] })
    expect(wildcard.allows('acme.test')).toBe(false)
    expect(wildcard.allows('www.acme.test')).toBe(true)
    expect(wildcard.allows('198.51.100.1')).toBe(false)
  })
  it.each([null, {}, { domains: ['bad/name.test'], ips: [] }, { domains: [], ips: ['198.51.100.0/33'] }, { domains: [], ips: ['xyz'] }, { domains: [], ips: [], exclude_domains: [1] }])('fails closed on uninterpretable gateway policy', (value) => {
    expect(() => new TargetScope(value)).toThrow('RECON_SCOPE')
  })
  it.each(['-h', '*.acme.test', 'acme.test/path', 'acme.test\nwidgets.test', 'a..acme.test', '198.51.100.1'])('rejects non-domain CLI inputs: %s', (target) =>{  expect(() => normalizeTarget(target, 'domain')).toThrow('RECON_TARGET') })
  it.each(['acme.test', '198.51.100.0/24', '::ffff:198.51.100.1', 'fe80::1%eth0'])('rejects ambiguous scanner input: %s', (target) =>{  expect(() => normalizeTarget(target, 'ip')).toThrow('RECON_TARGET') })
  it.each(['file:///etc/passwd', 'https://user:pass@acme.test', 'https://acme.test/#fragment', 'not a URL'])('rejects unsupported URL input: %s', (target) =>{  expect(() => normalizeTarget(target, 'url')).toThrow('RECON_TARGET') })
  it('canonicalizes DNS names, international names, URLs, and IPv6', () => {
    expect(() => normalizeTarget('invalid', 'url')).toThrow('RECON_TARGET')
    expect(normalizeTarget('https://198.51.100.1/', 'url')).toBe('https://198.51.100.1/')
    expect(new TargetScope({ domains: [], ips: ['2001:db8::1'] }).allows('2001:db8::1')).toBe(true)
    expect(normalizeTarget('ACME.TEST.', 'domain')).toBe('acme.test')
    expect(normalizeTarget('bücher.test', 'domain')).toBe('xn--bcher-kva.test')
    expect(normalizeTarget('https://ACME.TEST', 'url')).toBe('https://acme.test/')
    expect(normalizeTarget('2001:db8:0::1', 'ip')).toBe('2001:db8::1')
  })
})

describe('fixed CLI adapters and bounded inventory', () => {
  it('keeps passive discovery passive and active tools constrained', () => {
    expect(capabilities.filter(value => value.mode === 'passive').map(value => value.component)).toEqual(['subfinder', 'urlfinder'])
    for (const component of capabilities) {
      const args = argumentsFor(component.component, ['acme.test'], options)
      expect(args).toContain('-duc')
      expect(args).not.toEqual(expect.arrayContaining(['-active', '-nmap', '-hl', '-aff', '-tls-probe', '-csp-probe', '-fr']))
    }
    expect(argumentsFor('subfinder', ['acme.test'], options)).toEqual(expect.arrayContaining(['-s', 'crtsh', '-pc', '/tmp/private/providers.yaml']))
    expect(argumentsFor('naabu', ['198.51.100.1'], options)).toEqual(expect.arrayContaining(['-s', 'c', '-Pn', '-p', '80,443']))
    expect(argumentsFor('katana', ['https://acme.test/'], options)).toEqual(expect.arrayContaining(['-fs', 'fqdn', '-dr', '-mrs', '1024']))
    expect(argumentsFor('dnsx', ['acme.test'], options)).not.toContain('-config')
  })
  it('retains out-of-scope results as observations, without changing scope', () => {
    const result = observationsFrom('{"host":"widgets.test"}\n{"host":"acme.test"}\n{"host":"widgets.test"}\n', 'subfinder', scope, 4)
    expect(result).toEqual([
      { kind: 'domain', value: 'widgets.test', source: 'subfinder', inScope: false },
      { kind: 'domain', value: 'acme.test', source: 'subfinder', inScope: true },
    ])
    expect(scope.allows('widgets.test')).toBe(false)
    expect(observationsFrom('', 'subfinder', scope, 1)).toEqual([])
  })
  it('normalizes each supported JSONL format without retaining raw responses', () => {
    expect(observationsFrom('{"url":"https://acme.test"}', 'httpx', scope, 10)[0]).not.toHaveProperty('status')
    expect(observationsFrom('{"url":"https://widgets.test/"}', 'urlfinder', scope, 10)[0]).toHaveProperty('inScope', false)
    expect(observationsFrom('{"host":"acme.test","a":["198.51.100.1"],"aaaa":["2001:db8::1"],"cname":["widgets.test"]}', 'dnsx', scope, 10)).toHaveLength(4)
    expect(observationsFrom('{"url":"https://acme.test","status_code":200,"title":"Lab","tech":["nginx"],"body":"secret"}', 'httpx', scope, 10)[0]).toEqual({ kind: 'url', value: 'https://acme.test/', source: 'httpx', inScope: true, status: 200, title: 'Lab', technologies: ['nginx'] })
    expect(observationsFrom('{"ip":"198.51.100.1","port":443}', 'naabu', scope, 10)[0]).toHaveProperty('port', 443)
    expect(observationsFrom('{"request":{"endpoint":"https://acme.test/a"},"response":{"body":"secret"}}', 'katana', scope, 10)[0]).not.toHaveProperty('response')
  })
  it.each([
    ['subfinder', '{'], ['subfinder', '[]'], ['subfinder', '{}'], ['dnsx', '{"host":"acme.test","a":[1]}'],
    ['httpx', '{"url":"https://acme.test","status_code":999}'], ['httpx', '{"url":"https://acme.test","title":1}'],
    ['httpx', '{"url":"https://acme.test","tech":[1]}'], ['naabu', '{"ip":"198.51.100.1","port":0}'], ['katana', '{"request":{}}'],
  ] as const)('rejects malformed %s output', (component, text) =>{  expect(() => observationsFrom(text, component, scope, 10)).toThrow('RECON_OUTPUT') })
  it('rejects record and expansion overflow instead of silently truncating', () => {
    expect(() => observationsFrom('{"host":"acme.test"}\n{"host":"acme.test"}', 'subfinder', scope, 1)).toThrow('RECON_OUTPUT')
    expect(() => observationsFrom('{"host":"acme.test","a":["198.51.100.1"]}', 'dnsx', scope, 1)).toThrow('RECON_OUTPUT')
  })
})
