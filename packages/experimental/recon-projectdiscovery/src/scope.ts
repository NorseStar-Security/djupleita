/** Target authorization against gateway policy, excluding operational infrastructure grants. */
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import ipaddr from 'ipaddr.js'
import { ReconError } from '@deepseek-ai/dsh-experimental-recon'
import type { ReconCapability } from '@deepseek-ai/dsh-experimental-recon/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

function domain(value: string): string {
  if (/[\/\\:@?#\[\]%]/.test(value)) throw new ReconError('RECON_TARGET', 'Use a bare DNS name without a path, port, or query.')
  const host = domainToASCII(value.toLowerCase().replace(/\.$/, ''))
  if (host.length > 253 || !host.includes('.') || host.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || isIP(host)) {
    throw new ReconError('RECON_TARGET', 'Use an exact DNS name, HTTP(S) URL, or canonical IP appropriate to this operation.')
  }
  return host
}

/**
 * Normalize one untrusted target without accepting flags, files, CIDRs, credentials, or query syntax.
 * @param value - model-supplied target.
 * @param input - input category selected by the operation.
 * @returns canonical target spelling.
 */
export function normalizeTarget(value: string, input: ReconCapability['input']): string {
  if (value.trim() !== value || /[\x00-\x20\x7f]/.test(value)) throw new ReconError('RECON_TARGET', 'Targets must not contain whitespace or control characters.')
  if (input === 'ip') {
    if (!isIP(value) || value.includes('%') || (ipaddr.parse(value).kind() === 'ipv6' && ipaddr.process(value).kind() === 'ipv4')) {
      throw new ReconError('RECON_TARGET', 'Port scans require an explicit IPv4 or IPv6 address, not a domain or CIDR.')
    }
    return ipaddr.parse(value).toString()
  }
  if (input === 'domain') return domain(value)
  let url: URL
  try { url = new URL(value) } catch (cause) { throw new ReconError('RECON_TARGET', 'Use an absolute HTTP(S) URL.', { cause }) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new ReconError('RECON_TARGET', 'Use HTTP(S) URLs without credentials or fragments.')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) normalizeTarget(host, 'ip')
  else url.hostname = domain(host)
  return url.href
}

function network(value: string): [ipaddr.IPv4 | ipaddr.IPv6, number] {
  const [host, bits, ...extra] = value.split('/')
  if (extra.length || !host || !isIP(host) || host.includes('%') || (bits !== undefined && !/^\d+$/.test(bits))) throw new Error('invalid IP grant')
  const address = ipaddr.parse(host)
  if (address.kind() !== ipaddr.process(host).kind()) throw new Error('use IPv4 grants instead of IPv4-mapped IPv6')
  const prefix = bits === undefined ? (address.kind() === 'ipv4' ? 32 : 128) : Number(bits)
  if (prefix > (address.kind() === 'ipv4' ? 32 : 128)) throw new Error('invalid IP prefix')
  const cidr = `${host}/${prefix}`
  const base = address.kind() === 'ipv4' ? ipaddr.IPv4.networkAddressFromCIDR(cidr) : ipaddr.IPv6.networkAddressFromCIDR(cidr)
  if (address.toString() !== base.toString()) throw new Error('IP network has host bits set')
  return [address, prefix]
}

/** Policy-derived checker; infrastructure permissions are intentionally not target permissions. */
export class TargetScope {
  private readonly domains: string[]
  private readonly excludedDomains: string[]
  private readonly ips: ReturnType<typeof network>[]
  private readonly excludedIps: ReturnType<typeof network>[]

  constructor(policy: JsonValue) {
    try {
      if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('missing policy')
      const list = (key: string): string[] => {
        const value = policy[key]
        if (value === undefined) return []
        if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) throw new Error(`invalid ${key}`)
        return value as string[]
      }
      const names = (key: string) => list(key).map((value) => {
        if (/[^\x00-\x7f]/.test(value)) throw new Error('policy DNS names must use ASCII/Punycode')
        return value.startsWith('*.') ? `*.${domain(value.slice(2))}` : domain(value)
      })
      this.domains = names('domains')
      this.excludedDomains = names('exclude_domains')
      this.ips = list('ips').map(network)
      this.excludedIps = list('exclude_ips').map(network)
      if (!this.domains.length && !this.ips.length) throw new Error('missing target grants')
    } catch (cause) { throw new ReconError('RECON_SCOPE', 'The instructor policy could not be interpreted; no recon can run. Ask the instructor to correct it; DNS rules require explicit ASCII/Punycode names.', { cause }) }
  }

  /**
   * Check exact names, wildcard descendants, IP/CIDR grants, and overriding exclusions.
   * @param target - canonical DNS name, IP, or HTTP(S) URL.
   * @returns whether the destination is an authorized research target.
   */
  allows(target: string): boolean {
    const host = (target.includes('://') ? new URL(target).hostname : target).replace(/^\[|\]$/g, '')
    if (isIP(host)) {
      const address = ipaddr.parse(host)
      const matches = (entries: ReturnType<typeof network>[]) => entries.some(([base, bits]) =>
        base.kind() === address.kind() && address.match(base, bits))
      return !matches(this.excludedIps) && matches(this.ips)
    }
    const matches = (entries: string[]) => entries.some(entry => entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry)
    return !matches(this.excludedDomains) && matches(this.domains)
  }
}
