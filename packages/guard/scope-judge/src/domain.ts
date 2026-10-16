/** DNS and URL parsing shared by structured targets and the literal shell adapter. */
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'

/** A normalized exact domain or an explicitly authorized descendant suffix. */
export interface DomainRule {
  readonly domain: string
  readonly descendants: boolean
}

/**
 * Normalize one DNS name, rejecting IP literals, URL syntax, and ambiguous names.
 * @param value - hostname without port, credentials, path, or wildcard.
 * @returns lower-case ASCII DNS spelling, or undefined for invalid names.
 */
export function dnsName(value: string): string | undefined {
  if (value.length === 0 || /[\s%/@\\:#?\[\]*]/u.test(value)) return undefined
  const ascii = domainToASCII(value).toLowerCase().replace(/\.$/u, '')
  if (ascii.length === 0 || ascii.length > 253 || isIP(ascii) !== 0) return undefined
  if (!ascii.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))) return undefined
  // domainToASCII also canonicalizes legacy numeric IP spellings; isIP above rejects them.
  return ascii
}

/**
 * Parse an explicit HTTP(S) URL or a DNS host with an optional numeric port.
 * @param value - complete target string from one reviewed destination argument.
 * @returns normalized hostname, or undefined when the destination is indeterminate.
 */
export function targetDomain(value: string): string | undefined {
  if (value !== value.trim() || /[\s\\]/u.test(value)) return undefined
  if (!value.includes('://')) {
    const match = /^([^:]+)(?::([0-9]+))?$/u.exec(value)
    const host = match?.[1]
    const port = match?.[2]
    if (host === undefined || (port !== undefined && !validPort(port))) return undefined
    return dnsName(host)
  }
  if (!/^https?:\/\//iu.test(value)) return undefined
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  if (url.username !== '' || url.password !== '' || url.hostname === '') return undefined
  return dnsName(url.hostname)
}

/** Validate an explicit TCP/UDP port without accepting URL-parser coercions. */
function validPort(value: string): boolean {
  const port = Number(value)
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

/**
 * Compile instructor-owned domain rules; malformed scope stops plugin loading.
 * @param values - exact DNS names and optional leading `*.` descendant rules.
 * @returns normalized rules without implicit subdomain authorization.
 */
export function domainRules(values: readonly string[]): DomainRule[] {
  if (values.length === 0) throw new Error('scope-judge: domains must not be empty')
  return values.map((value) => {
    const descendants = value.startsWith('*.')
    const domain = dnsName(descendants ? value.slice(2) : value)
    if (domain === undefined) throw new Error(`scope-judge: invalid domain rule ${JSON.stringify(value)}; use a DNS name or *.domain`)
    return { domain, descendants }
  })
}

/**
 * Compare canonical names using DNS-label boundaries.
 * @param domain - normalized target hostname.
 * @param rules - normalized deployment scope.
 * @returns whether at least one explicit rule authorizes the hostname.
 */
export function inScope(domain: string, rules: readonly DomainRule[]): boolean {
  return rules.some(rule => rule.descendants ? domain.endsWith(`.${rule.domain}`) : domain === rule.domain)
}
