/** Explicit field inventory, shared by staged forms and their tests. */
import type { CourseConfiguration } from '../types.ts'

/** One JSON leaf edited in a dedicated settings field. */
export interface Field { path: string; kind: 'lines' | 'json' | 'number' | 'string' | 'boolean'; fallback: unknown; advanced?: boolean }
/** Scope policy and inspection controls. */
export const scopeFields: Field[] = [
  { path: 'policy.domains', kind: 'lines', fallback: [] }, { path: 'policy.ips', kind: 'lines', fallback: [] },
  { path: 'policy.exclude_domains', kind: 'lines', fallback: [] }, { path: 'policy.exclude_ips', kind: 'lines', fallback: [] },
  { path: 'policy.infrastructure', kind: 'json', fallback: {} }, { path: 'policy.ports', kind: 'json', fallback: { http: [80], https: [443] } },
  { path: 'policy.operations', kind: 'json', fallback: {} },
  { path: 'actionReview', kind: 'json', fallback: {} },
  { path: 'policy.domain_addresses', kind: 'json', fallback: {}, advanced: true },
  { path: 'provider.socketPath', kind: 'string', fallback: '/run/course-public/control.sock', advanced: true },
  { path: 'provider.timeoutMs', kind: 'number', fallback: 5000, advanced: true },
  { path: 'provider.maxResponseBytes', kind: 'number', fallback: 1048576, advanced: true },
  { path: 'guard.pollIntervalMs', kind: 'number', fallback: 1000, advanced: true },
  { path: 'guard.targetTools', kind: 'json', fallback: [], advanced: true },
  { path: 'forwardOpenAIKey', kind: 'boolean', fallback: false, advanced: true },
]
/** Recon budgets and explicitly chosen tools and passive sources. */
export const reconFields: Field[] = [
  { path: 'recon.sources', kind: 'json', fallback: {} }, { path: 'recon.ports', kind: 'json', fallback: [80, 443] },
  ...['rate', 'concurrency', 'depth', 'timeoutMs', 'maxTargets', 'maxRecords', 'maxBytes', 'responseMaxBytes'].map(key => ({ path: `recon.${key}`, kind: 'number' as const, fallback: 1 })),
  { path: 'recon.executables', kind: 'json', fallback: {}, advanced: true }, { path: 'recon.proxy', kind: 'string', fallback: 'http://127.0.0.1:3128', advanced: true },
  { path: 'recon.resolver', kind: 'string', fallback: '127.0.0.1', advanced: true }, { path: 'recon.graceMs', kind: 'number', fallback: 1000, advanced: true },
]
/** Read one configured leaf without mutation.
 * @param config - Saved or isolated staged configuration.
 * @param field - Declared form field and fallback.
 * @returns The configured leaf or its fallback. */
export function get(config: CourseConfiguration, field: Field): unknown {
  let value: unknown = config
  for (const key of field.path.split('.')) value = value !== null && typeof value === 'object' ? Reflect.get(value, key) : undefined
  return value ?? field.fallback
}
/** Apply one staged leaf to an isolated copy.
 * @param config - Isolated editable configuration.
 * @param path - Declared dotted field path.
 * @param value - Parsed field value. */
export function put(config: CourseConfiguration, path: string, value: unknown): void {
  const keys = path.split('.')
  let target: object = config
  for (const key of keys.slice(0, -1)) {
    if (Reflect.get(target, key) === undefined) Reflect.set(target, key, {})
    const next: unknown = Reflect.get(target, key)
    if (next === null || typeof next !== 'object') throw new TypeError('Expected a settings object')
    target = next
  }
  const last = keys.at(-1)
  if (last === undefined) throw new TypeError('Expected a field path')
  Reflect.set(target, last, value)
}
/** Render a leaf as editable text.
 * @param field - Declared presentation kind.
 * @param value - Configured field value.
 * @returns Editable text for this field. */
export function format(field: Field, value: unknown): string {
  if (field.kind === 'lines' && Array.isArray(value)) return value.join('\n')
  return field.kind === 'json' ? JSON.stringify(value, null, 2) : String(value)
}
/** Parse one field; host schemas and Python policy validation remain authoritative.
 * @param field - Declared input kind.
 * @param text - Staged field text.
 * @returns Parsed JSON-compatible input; invalid values throw. */
export function parse(field: Field, text: string): unknown {
  if (field.kind === 'lines') return text.split('\n').map(row => row.trim()).filter(Boolean)
  if (field.kind === 'json') return JSON.parse(text)
  if (field.kind === 'number') { const n = Number(text); if (!text.trim() || !Number.isSafeInteger(n) || n < 1) throw new Error('invalid'); return n }
  if (field.kind === 'boolean') return text === 'true'
  return text
}
