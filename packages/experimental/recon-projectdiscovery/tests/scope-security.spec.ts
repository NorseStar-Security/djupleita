import { describe, expect, it } from 'vitest'
import { normalizeTarget, TargetScope } from '../src/scope.ts'

describe('target authorization against gateway policy syntax', () => {
  it('accepts domain-only or IP-only policies without inventing another grant category', () => {
    const domains = new TargetScope({ domains: ['acme.test'] })
    expect(domains.allows('acme.test')).toBe(true)
    expect(domains.allows('widgets.test')).toBe(false)
    expect(domains.allows('198.51.100.1')).toBe(false)
    const ips = new TargetScope({ ips: ['198.51.100.0/024'] })
    expect(ips.allows('198.51.100.1')).toBe(true)
    expect(ips.allows('acme.test')).toBe(false)
  })

  it.each([
    '198.51.100.9/24', '198.51.100.0/24/extra', '198.51.100.0/',
    '2001:db8::1/32', '2001:db8::/32/extra', '::ffff:198.51.100.0/120', '::ffff:198.51.100.1',
  ])('rejects an IP grant the Linux gateway cannot load: %s', (grant) => {
    expect(() => new TargetScope({ domains: [], ips: [grant] })).toThrow('RECON_SCOPE')
    expect(() => new TargetScope({ domains: ['acme.test'], ips: [], exclude_ips: [grant] })).toThrow('RECON_SCOPE')
  })

  it.each([{}, { domains: [], ips: [] }, { infrastructure: { 'api.vendor.test': { methods: ['GET'], paths: ['/'] } } }])('rejects a policy without research targets', (policy) => {
    expect(() => new TargetScope(policy)).toThrow('RECON_SCOPE')
  })

  it('matches exact network endpoints and exclusions in each address family', () => {
    const scope = new TargetScope({ ips: ['198.51.100.0/24', '2001:db8::/126'], exclude_ips: ['198.51.100.0/31', '2001:db8::2/127'] })
    for (const address of ['198.51.100.2', '198.51.100.255', '2001:db8::', '2001:db8::1']) expect(scope.allows(address)).toBe(true)
    for (const address of ['198.51.100.0', '198.51.100.1', '198.51.101.0', '2001:db8::2', '2001:db8::3', '2001:db8::4']) expect(scope.allows(address)).toBe(false)
  })
})

describe('policy names cannot change identity between IDNA implementations', () => {
  it.each(['faß.test', 'ς.test', 'βόλος.test', 'foo\u200cbar.test', 'foo\u200dbar.test', 'acme\u3002com'])('requires explicit ASCII/Punycode for policy name %s', (name) => {
    for (const rule of [name, `*.${name}`]) {
      expect(() => new TargetScope({ domains: [rule] })).toThrow(/RECON_SCOPE.*ASCII\/Punycode/)
      expect(() => new TargetScope({ domains: ['acme.test'], exclude_domains: [rule] })).toThrow(/RECON_SCOPE.*ASCII\/Punycode/)
    }
  })

  it('does not let a Unicode policy grant promote operational infrastructure to a target', () => {
    expect(() => new TargetScope({ domains: ['faß.test'], infrastructure: { 'xn--fa-hia.test': { methods: ['GET'], paths: ['/'] } } })).toThrow(/RECON_SCOPE.*ASCII\/Punycode/)
  })

  it('keeps Unicode tool inputs available through explicit ASCII policy names', () => {
    const scope = new TargetScope({ domains: ['xn--fa-hia.test', 'xn--3xa.test', 'xn--bcher-kva.test'] })
    for (const target of ['faß.test', 'ς.test', 'bücher.test']) {
      expect(scope.allows(normalizeTarget(target, 'domain'))).toBe(true)
      expect(scope.allows(normalizeTarget(`https://${target}/`, 'url'))).toBe(true)
    }
    expect(scope.allows('fass.test')).toBe(false)
    expect(scope.allows('xn--4xa.test')).toBe(false)
  })
})

describe('canonical destinations cannot turn Acme grants into Box grants', () => {
  const scope = new TargetScope({ domains: ['acme.test', '*.acme.test'], ips: [], exclude_domains: ['*.private.acme.test', 'private.acme.test'], infrastructure: { 'widgets.test': { methods: ['GET'], paths: ['/'] } } })

  it.each([
    'widgets.test', 'acme.test.widgets.test', 'acme.test-widgets.test', 'acme.test\u3002widgets.test', 'dr\u03bfpwidgets.test',
    'private.acme.test', 'api.private.acme.test',
  ])('rejects a canonical ungranted or excluded name: %s', (target) => {
    expect(scope.allows(normalizeTarget(target, 'domain'))).toBe(false)
  })

  it.each([
    'https://widgets.test/?next=https://acme.test/', 'https://acme.test.widgets.test/',
    'https://%62ox.com/', 'https://acme.test%2ewidgets.test/', 'https://2130706433/',
    'https://api.private.acme.test/',
  ])('checks the canonical URL host, not trusted-looking URL text: %s', (target) => {
    expect(scope.allows(normalizeTarget(target, 'url'))).toBe(false)
  })

  it.each([
    'https://acme.test@widgets.test/', 'https://acme.test%40widgets.test/',
    'https://acme.test%2f@widgets.test/', 'https://acme.test/#@widgets.test/', 'https://[::ffff:198.51.100.1]/',
  ])('rejects credentials, ambiguous authority, fragments, and mapped addresses: %s', (target) => {
    expect(() => normalizeTarget(target, 'url')).toThrow('RECON_TARGET')
  })

  it('passes only the canonical authorized hostname onward to the CLI', () => {
    expect(normalizeTarget('ACME.COM.', 'domain')).toBe('acme.test')
    expect(normalizeTarget('acme\u3002com', 'domain')).toBe('acme.test')
    const target = normalizeTarget('https://ACME.COM./@widgets.test/', 'url')
    expect(target).toBe('https://acme.test/@widgets.test/')
    expect(scope.allows(target)).toBe(true)
  })
})
