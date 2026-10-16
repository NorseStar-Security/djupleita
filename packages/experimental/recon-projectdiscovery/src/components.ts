/** Fixed ProjectDiscovery CLI adapters; no model-controlled flags or shell interpolation. */
import { ReconError } from '@deepseek-ai/dsh-experimental-recon'
import type { ReconCapability, ReconComponent, ReconObservation } from '@deepseek-ai/dsh-experimental-recon/types'
import { normalizeTarget, type TargetScope } from './scope.ts'

/** Operations exposed by this provider, ordered passive-first. */
export const capabilityByComponent: Readonly<Record<ReconComponent, ReconCapability>> = {
  subfinder: { component: 'subfinder', mode: 'passive', input: 'domain', description: 'Passive subdomain enumeration from third-party sources.' },
  urlfinder: { component: 'urlfinder', mode: 'passive', input: 'domain', description: 'Historical URLs from passive archives; results may be stale or outside scope.' },
  dnsx: { component: 'dnsx', mode: 'active', input: 'domain', description: 'Resolve A, AAAA, and CNAME records using the instructor resolver.' },
  httpx: { component: 'httpx', mode: 'active', input: 'url', description: 'Probe HTTP status, title, and technology; do not follow redirects.' },
  naabu: { component: 'naabu', mode: 'active', input: 'ip', description: 'TCP CONNECT scan of instructor-selected ports on explicitly authorized IPs.' },
  katana: { component: 'katana', mode: 'active', input: 'url', description: 'Bounded standard HTTP crawl of the exact hostname, without redirect following or form filling.' },
}

/** Passive-first catalog derived from the exhaustive component definitions. */
export const capabilities: readonly ReconCapability[] = Object.values(capabilityByComponent)

/** Execution budgets resolved from provider configuration. */
export interface AdapterOptions {
  readonly proxy: string
  readonly resolver: string
  readonly rate: number
  readonly concurrency: number
  readonly depth: number
  readonly ports: readonly number[]
  readonly home: string
  readonly sources: { readonly subfinder: readonly string[]; readonly urlfinder: readonly string[] }
  readonly responseMaxBytes: number
}

/**
 * Build flags for one subprocess; targets are provided separately over stdin or validated domain arguments.
 * @param component - selected operation.
 * @param targets - canonical authorized inputs.
 * @param options - instructor-owned execution settings.
 * @returns fixed CLI arguments without the executable.
 */
export function argumentsFor(component: ReconComponent, targets: readonly string[], options: AdapterOptions): string[] {
  const common = ['-silent', '-nc', '-duc']
  const config = ['-config', `${options.home}/config.yaml`]
  const rate = String(options.rate)
  const concurrency = String(options.concurrency)
  switch (component) {
    case 'subfinder': return [...common, ...config, '-d', targets.join(','), '-s', options.sources.subfinder.join(','), '-oJ', '-cs', '-rl', rate, '-proxy', options.proxy, '-pc', `${options.home}/providers.yaml`]
    case 'urlfinder': return [...common, ...config, '-d', targets.join(','), '-s', options.sources.urlfinder.join(','), '-j', '-cs', '-rl', rate, '-proxy', options.proxy, '-pc', `${options.home}/providers.yaml`]
    case 'dnsx': return [...common, '-j', '-omit-raw', '-a', '-aaaa', '-cname', '-r', options.resolver, '-rl', rate, '-t', concurrency]
    case 'httpx': return [...common, ...config, '-j', '-sc', '-title', '-td', '-ob', '-proxy', options.proxy, '-r', options.resolver, '-rl', rate, '-threads', concurrency]
    case 'naabu': return [...common, ...config, '-j', '-s', 'c', '-Pn', '-stream', '-p', options.ports.join(','), '-rate', rate, '-c', concurrency]
    case 'katana': return [...common, ...config, '-j', '-fs', 'fqdn', '-dr', '-mrs', String(options.responseMaxBytes), '-d', String(options.depth), '-rl', rate, '-c', concurrency, '-proxy', options.proxy, '-r', options.resolver]
  }
}

/**
 * Parse complete JSONL into deduplicated observations, not new authorizations.
 * @param text - non-truncated stdout from a successful CLI.
 * @param component - output format to interpret.
 * @param scope - immutable target authorization snapshot.
 * @param maxRecords - maximum accepted source records and normalized observations.
 * @returns normalized inventory; empty successful output is valid.
 * @throws ReconError on malformed JSON, missing required fields, or exceeded budgets.
 */
export function observationsFrom(text: string, component: ReconComponent, scope: TargetScope, maxRecords: number): ReconObservation[] {
  try {
    const observations = new Map<string, ReconObservation>()
    const lines = text.split('\n').filter(line => line.trim())
    if (lines.length > maxRecords) throw new Error('record budget exceeded')
    const add = (kind: ReconObservation['kind'], value: string, extra: { subject?: string; port?: number; status?: number; title?: string; technologies?: string[] } = {}) => {
      const normalized = normalizeTarget(value, kind === 'url' ? 'url' : kind === 'domain' ? 'domain' : 'ip')
      const item = { kind, value: normalized, source: component, inScope: scope.allows(normalized), ...extra }
      observations.set(JSON.stringify([kind, normalized, extra.port, extra.subject]), item)
      if (observations.size > maxRecords) throw new Error('observation budget exceeded')
    }
    for (const line of lines) {
      const row: unknown = JSON.parse(line)
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('expected object')
      const record = row as Record<string, unknown>
      const string = (key: string) => { const value = record[key]; if (typeof value !== 'string') throw new Error(`missing ${key}`); return value }
      switch (component) {
        case 'subfinder': add('domain', string('host')); break
        case 'urlfinder': add('url', string('url')); break
        case 'dnsx':
          add('domain', string('host'))
          for (const key of ['a', 'aaaa', 'cname']) {
            if (record[key] === undefined) continue
            const values = record[key]
            if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) throw new Error('invalid DNS records')
            for (const value of values as string[]) add(key === 'cname' ? 'domain' : 'ip', value, { subject: normalizeTarget(string('host'), 'domain') })
          }
          break
        case 'httpx': {
          const status = record.status_code
          const title = record.title
          const technologies = record.tech
          if (status !== undefined && (!Number.isInteger(status) || typeof status !== 'number' || status < 100 || status > 599)) throw new Error('invalid status')
          if (title !== undefined && typeof title !== 'string') throw new Error('invalid title')
          if (technologies !== undefined && (!Array.isArray(technologies) || technologies.some(value => typeof value !== 'string'))) throw new Error('invalid technology list')
          add('url', string('url'), { ...typeof status === 'number' ? { status } : {}, ...typeof title === 'string' ? { title } : {}, ...Array.isArray(technologies) ? { technologies: technologies as string[] } : {} })
          break
        }
        case 'naabu': {
          const port = record.port
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port')
          add('service', string('ip'), { port }); break
        }
        case 'katana': {
          const request = record.request
          if (!request || typeof request !== 'object' || !('endpoint' in request) || typeof request.endpoint !== 'string') throw new Error('missing request endpoint')
          add('url', request.endpoint); break
        }
      }
    }
    return [...observations.values()]
  } catch (cause) { throw new ReconError('RECON_OUTPUT', 'The recon output is malformed or exceeds the inventory budget; no partial inventory was accepted.', { cause }) }
}
