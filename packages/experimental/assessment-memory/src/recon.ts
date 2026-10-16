/** ProjectDiscovery inventory adapter; only schema-valid accepted results become asset facts. */
import { z } from 'zod'
import { isIP } from 'node:net'
import { digest, normalize } from './identity.ts'
import type { Observation } from './schema.ts'

const row = z.object({ kind: z.enum(['domain', 'url', 'ip', 'service']), value: z.string(),
  source: z.enum(['subfinder', 'urlfinder', 'dnsx', 'httpx', 'naabu', 'katana']), inScope: z.boolean(),
  subject: z.string().optional(), port: z.number().int().min(1).max(65535).optional(),
  status: z.number().int().min(100).max(599).optional(), title: z.string().optional(), technologies: z.array(z.string()).optional(),
}).strict().refine(value => value.kind !== 'service' || value.port !== undefined, 'service requires port')
const inventory = z.object({ component: z.enum(['subfinder', 'urlfinder', 'dnsx', 'httpx', 'naabu', 'katana']),
  mode: z.enum(['active', 'passive']), targets: z.array(z.string()), policyHash: z.string(),
  coverage: z.literal('best-effort'), diagnosticsPresent: z.boolean(), observations: z.array(row).max(10000),
}).strict()

/** Convert accepted structured recon output without treating discovery as authorization.
 * @param raw - canonical tool value, encoded by recon_run as JSON text.
 * @param policyHash - policy revision pinned to this engagement.
 * @returns canonical observations and supported structural relationships.
 */
export function reconCapture(raw: unknown, policyHash: string): {
  observations: Observation[]
  relationships: { source: Observation; target: Observation; relation: string }[]
  policyHash: string
  coverage: 'best-effort'
} {
  const result = inventory.parse(typeof raw === 'string' ? JSON.parse(raw) : raw)
  if (result.policyHash !== policyHash) throw new Error('Recon policy differs from the configured assessment; configure a new assessment revision.')
  const observations: Observation[] = []
  const relationships: { source: Observation; target: Observation; relation: string }[] = []
  const seen = new Map<string, { index: number; structural: boolean }>()
  const add = (input: Observation, structural = false) => {
    const value = normalize(input)
    const key = digest([value.kind, value.value, value.port ?? null])
    const previous = seen.get(key)
    if (previous && structural) return observations[previous.index] ?? value
    if (previous?.structural) observations[previous.index] = value
    else observations.push(value)
    seen.set(key, { index: previous?.structural ? previous.index : observations.length - 1, structural })
    return value
  }
  const base = (kind: Observation['kind'], value: string): Observation => ({ kind, value, attributes: {}, confidence: 1,
    basis: 'observed' })
  for (const item of result.observations) {
    if (item.source !== result.component) throw new Error('Recon observation source differs from the executed component.')
    const attributes: Observation['attributes'] = { inScopeAtObservation: item.inScope, source: item.source }
    if (item.status !== undefined) attributes.status = item.status
    if (item.title !== undefined) attributes.title = item.title
    if (item.technologies !== undefined) attributes.technologies = item.technologies.join(', ')
    const target = add({ ...base(item.kind, item.value), attributes, ...item.port !== undefined ? { port: item.port } : {} })
    if (item.subject) {
      const source = add(base('domain', item.subject), true)
      relationships.push({ source, target, relation: item.kind === 'domain' ? 'x-assessment:AliasOf' : 'x-assessment:ResolvesTo' })
    }
    if (item.kind === 'url') {
      const host = new URL(item.value).hostname.replace(/^\[|\]$/g, '')
      const source = add(base(isIP(host) ? 'ip' : 'domain', host), true)
      relationships.push({ source, target, relation: 'x-assessment:HasEndpoint' })
    }
    if (item.kind === 'service') {
      const source = add(base('ip', item.value), true)
      relationships.push({ source, target, relation: 'x-assessment:ExposesService' })
    }
  }
  return { observations, relationships, policyHash: result.policyHash, coverage: 'best-effort' as const }
}
