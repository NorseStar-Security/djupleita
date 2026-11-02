/** Exact destination checks and DNS-pinned connection grants. */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import ipaddr from 'ipaddr.js';
import { PentestError, ScopeSchema, digest, freeze } from '@dsh-pentest/contracts';
import type { Destination, HostRule, Scope, Json } from '@dsh-pentest/contracts';

export interface ScopeReviewer {
  allows(category: string, details: Json): boolean;
  request(category: string, details: Json, reason: string, signal: AbortSignal): Promise<boolean>;
}
export interface Address { address: string; family: number }
export type Resolver = (host: string) => Promise<Address[]>;
export interface ConnectionGrant {
  url: URL;
  addresses: readonly Address[];
  scopeVersion: string;
  rule: HostRule;
}

function hostname(value: string): string {
  const unwrapped = value.startsWith('[') ? value.slice(1, -1) : value;
  if (isIP(unwrapped)) return ipaddr.process(unwrapped).toString();
  const normalized = domainToASCII(unwrapped.toLowerCase().replace(/\.$/, ''));
  if (!normalized || normalized.includes('..') || !/^[a-z0-9.-]+$/.test(normalized)) {
    throw new PentestError('INVALID_HOST', 'Invalid destination hostname');
  }
  return normalized;
}
export { hostname as normalizeHostname };

function pattern(value: string): string {
  const wildcard = value.startsWith('*.');
  const name = hostname(wildcard ? value.slice(2) : value);
  if (value.includes('*') && (!wildcard || value.slice(2).includes('*') || isIP(name))) {
    throw new PentestError('INVALID_SCOPE', 'Wildcards must be a leading *. on a DNS name');
  }
  return wildcard ? `*.${name}` : name;
}

export function matchesHost(host: string, rule: string): boolean {
  const name = hostname(host);
  const normalized = pattern(rule);
  return normalized.startsWith('*.')
    ? name.endsWith(normalized.slice(1)) && name !== normalized.slice(2)
    : name === normalized;
}

function inNetwork(address: string, network: string): boolean {
  let parsed = ipaddr.process(address);
  const [base, bits] = ipaddr.parseCIDR(network);
  if (parsed.kind() !== base.kind()) return false;
  return parsed.match(base, bits);
}

/** An engagement owns one immutable scope revision. New scope requires a new service. */
export class ScopeService {
  readonly version: string;
  readonly scope: Readonly<Scope>;
  constructor(scope: Scope, private readonly resolver: Resolver = host => lookup(host, { all: true, verbatim: true }), private readonly reviewer?: ScopeReviewer) {
    const parsed = ScopeSchema.parse(scope);
    for (const rule of [...parsed.targets, ...Object.values(parsed.services).flat()]) rule.host = pattern(rule.host);
    parsed.exclusions = parsed.exclusions.map(pattern);
    for (const network of parsed.networks) {
      try { ipaddr.parseCIDR(network); }
      catch (cause) { throw new PentestError('INVALID_SCOPE', `Invalid scope network: ${network}`, { cause }); }
    }
    this.scope = freeze(parsed);
    this.version = digest(parsed);
  }

  /** API roots selected in Models are independent of engagement target permissions. */
  forModelEndpoints(endpoints: readonly string[]): ScopeService {
    const networks = [...this.scope.networks];
    const rules: HostRule[] = endpoints.map(endpoint => {
      let url: URL;
      try { url = new URL(endpoint); }
      catch { throw new PentestError('MODEL_ENDPOINT', 'The configured model provider has an invalid API endpoint'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new PentestError('MODEL_ENDPOINT', 'Model provider endpoints require HTTP(S) without URL credentials');
      }
      const host = hostname(url.hostname), ip = isIP(host);
      const loopback = host === 'localhost' || host.endsWith('.localhost')
        || (ip && ipaddr.process(host).range() === 'loopback');
      if (loopback) networks.push(...(ip ? [`${host}/${ip === 4 ? 32 : 128}`] : ['127.0.0.0/8', '::1/128']));
      return { host, schemes: [url.protocol === 'https:' ? 'https' : 'http'],
        ports: [Number(url.port || (url.protocol === 'https:' ? 443 : 80))],
        // A configured gateway may resolve to RFC1918/ULA without a .local suffix.
        // This grant is confined to model traffic at this API root. Loopback and
        // other restricted ranges still require the explicit network grants above.
        pathPrefixes: [url.pathname.replace(/\/+$/, '') || '/'], allowPrivateAddresses: true };
    });
    return new ScopeService({ targets: [], exclusions: [], networks: [...new Set(networks)],
      services: { model: rules, intelligence: [], telemetry: [] } }, this.resolver, this.reviewer);
  }

  /** Validate a URL without resolving it; safe to use in synchronous guards. */
  check(destination: Destination): { url: URL; rule: HostRule } {
    let url: URL;
    try { url = new URL(destination.url); }
    catch (cause) { throw new PentestError('INVALID_DESTINATION', 'Invalid destination URL', { cause }); }
    if (url.username || url.password) throw new PentestError('URL_CREDENTIALS', 'Credentials must use identity references');
    const host = hostname(url.hostname);
    const override = this.reviewer?.allows('scope', destination) ?? false;
    if (!override && this.scope.exclusions.some(rule => matchesHost(host, rule))) {
      throw new PentestError('OUT_OF_SCOPE', `Excluded destination: ${host}`);
    }
    const scheme = url.protocol.slice(0, -1);
    if (!['http', 'https', 'tcp', 'tls'].includes(scheme)) throw new PentestError('INVALID_DESTINATION', 'Destination protocol is not supported');
    const port = url.port ? Number(url.port) : scheme === 'https' || scheme === 'tls' ? 443 : scheme === 'http' ? 80 : 0;
    const rules = destination.purpose === 'target' ? this.scope.targets : this.scope.services[destination.purpose];
    const rule = rules.find(candidate => matchesHost(host, candidate.host)
      && candidate.schemes.some(allowed => allowed === scheme)
      && candidate.ports.includes(port)
      && candidate.pathPrefixes.some(prefix => url.pathname === prefix
        || url.pathname.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
    const selected = rule ?? (override ? { host, schemes: [scheme as HostRule['schemes'][number]], ports: [port], pathPrefixes: [url.pathname], allowPrivateAddresses: false } : undefined);
    if (!selected) throw new PentestError('OUT_OF_SCOPE', `Destination is outside ${destination.purpose} scope: ${host}:${port}`);
    if (!override && destination.purpose === 'target' && isIP(host) && !this.scope.networks.some(network => inNetwork(host, network))) {
      throw new PentestError('OUT_OF_SCOPE', 'Direct IP access requires an explicit scope network');
    }
    return { url, rule: selected };
  }

  /** Pause at a scope boundary; the reviewer applies exact-operation or explicit host allowances. */
  async ensure(destination: Destination, signal: AbortSignal): Promise<void> {
    try {
      this.check(destination);
      if (this.reviewer?.allows('scope', destination)) await this.reviewer.request('scope', destination, 'Saved destination allowance', signal);
    }
    catch (error) {
      if (!(error instanceof PentestError) || error.code !== 'OUT_OF_SCOPE'
        || !await this.reviewer?.request('scope', destination, error.message, signal)) throw error;
      this.check(destination);
    }
  }

  /** Resolve once and return only approved addresses for the actual socket lookup. */
  async authorize(destination: Destination, signal?: AbortSignal): Promise<ConnectionGrant> {
    signal?.throwIfAborted();
    await this.ensure(destination, signal ?? new AbortController().signal);
    const { url, rule } = this.check(destination);
    const host = hostname(url.hostname);
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await this.resolver(host);
    signal?.throwIfAborted();
    if (!addresses.length) throw new PentestError('DNS_EMPTY', 'Destination resolved to no addresses');
    for (const entry of addresses) {
      const parsed = ipaddr.process(entry.address);
      if (entry.family !== isIP(entry.address)) throw new PentestError('DNS_INVALID', 'DNS address family mismatch');
      const allowedPrivate = rule.allowPrivateAddresses && ['private', 'uniqueLocal'].includes(parsed.range());
      if (parsed.range() !== 'unicast' && !allowedPrivate
        && !this.scope.networks.some(network => inNetwork(entry.address, network))) {
        const details = { destination, address: entry.address, family: entry.family };
        const reason = `Destination resolves to an unapproved ${parsed.range()} address: ${entry.address}`;
        if (!await this.reviewer?.request('network', details, reason, signal ?? new AbortController().signal)) {
          throw new PentestError('NETWORK_DENIED', reason);
        }
      }
    }
    return Object.freeze({ url, rule, addresses: Object.freeze(addresses.map(entry => Object.freeze({ ...entry }))), scopeVersion: this.version });
  }
}
