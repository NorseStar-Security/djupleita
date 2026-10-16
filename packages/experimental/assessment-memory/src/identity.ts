/** Stable asset identities and canonical hashes for deduplication and evidence. */
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { domainToASCII } from 'node:url'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AssetId, Observation } from './schema.ts'

/** Hash a canonical JSON value without depending on object property insertion order.
 * @param value - JSON-compatible value.
 * @returns lowercase SHA-256 digest.
 */
export function digest(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical)
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a],
      [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => [key, canonical(value)]))
    return item
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
}

/** Validate and canonicalize one asset without inferring ownership or authorization.
 * @param input - validated observation input.
 * @returns observation with canonical identity fields.
 */
export function normalize(input: Observation): Observation {
  let value = input.value.trim()
  if (input.identity && !['identity', 'resource', 'business-service'].includes(input.kind)) throw new Error('Native identities apply to identity, resource or business-service observations; DNS and endpoint identities retain their own semantics.')
  switch (input.kind) {
    case 'domain':
      value = domainToASCII(value.replace(/\.$/, '').toLowerCase())
      if (!value || value.length > 253 || !value.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw new Error('Invalid domain observation; supply a DNS hostname.')
      break
    case 'ip':
    case 'service':
      if (!isIP(value)) throw new Error('Invalid IP observation; supply a single IPv4 or IPv6 address.')
      if (isIP(value) === 6) value = new URL(`http://[${value}]/`).hostname.slice(1, -1)
      break
    case 'url': {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('URL observations require HTTP(S) without embedded credentials.')
      // Query values can contain credentials and are not part of the endpoint identity.
      url.search = ''; url.hash = ''
      url.hostname = url.hostname.replace(/\.$/, '')
      value = url.href
      break
    }
    case 'identity':
    case 'resource':
    case 'business-service':
      break
  }
  if (!value) throw new Error('Asset value is empty.')
  return { ...input, value }
}

/** Derive one business-local asset id; observations from repeated assessments converge.
 * @param businessId - operator-selected business namespace.
 * @param input - canonical observation.
 * @returns stable opaque asset identity.
 */
export function assetIdentity(businessId: string, input: Observation): AssetId {
  if (input.identity) return brandString<AssetId>(digest([businessId, 'native', input.identity.provider,
    input.identity.realm, input.identity.nativeType, input.identity.nativeId]))
  return brandString<AssetId>(digest([businessId, input.kind, input.value, input.kind === 'service' ? input.port : null]))
}
