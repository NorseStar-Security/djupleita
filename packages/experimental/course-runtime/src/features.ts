/** Native profile export limited to model settings, selected bundles, and their referenced stored keys. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type {} from '@deepseek-ai/dsh-experimental-trajectory-projection'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** Private launch input; never part of the browser's status or saved policy response. */
export interface NativeFeatures {
  bundles: string[]
  patches: { id: string; config: JsonValue }[]
  credentials: { version: 1; refs: Record<string, string>; records: Record<string, JsonValue> }
  trajectories: boolean
  /** Gateway-only keys; stripped before writing the research-visible native.json. */
  reviewCredentials?: Record<string, string>
}

const modelNamespaces = new Set(['llm-pi-ai', 'llm-deepseek-api-key', 'llm-deepseek', 'agent-default-model', 'subagent', 'auto-review'])

/**
 * Capture only configured model credentials, leaving account grants and unrelated host secrets on the Mac.
 * @param ctx - native profile context; research never invokes this exporter.
 * @param review - Instructor-selected evaluator references, resolved only into gateway launch input.
 * @returns private configuration transferred over the owned deployment process's stdin.
 */
export async function nativeFeatures(ctx: Context, review?: Record<string, JsonValue>): Promise<NativeFeatures> {
  const bundles = (await ctx.get('pluginManager')?.listBundles() ?? []).filter(row => row.enabled).map(row => row.name)
  const patches = (ctx.get('settings')?.describe() ?? []).filter(row => modelNamespaces.has(row.ns)).map((row) => {
    if (!isJsonValue(row.value)) throw new Error(`Model configuration ${row.ns} cannot be transferred to Protected`)
    return { id: String(row.ns), config: row.value as JsonValue }
  })
  const refs: Record<string, string> = {}
  const records: Record<string, JsonValue> = {}
  const credentials = ctx.get('credentials')
  const visit = async (value: JsonValue): Promise<void> => {
    if (value === null || typeof value !== 'object') return
    if (!Array.isArray(value) && typeof value.apiKeyEnv === 'string') {
      const ref = credentialRef(value.apiKeyEnv)
      const resolved = await credentials?.resolve(ref)
      // Environment forwarding remains a separate explicit option. Only product-saved references are inherited.
      if (resolved?.source === 'file') refs[ref] = resolved.value
    }
    for (const child of Object.values(value)) await visit(child)
  }
  for (const patch of patches) {
    await visit(patch.config)
    if (patch.id !== 'llm-pi-ai' || patch.config === null || typeof patch.config !== 'object' || Array.isArray(patch.config)) continue
    const providers = patch.config.providers
    if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) continue
    for (const provider of Object.keys(providers)) {
      const key = credentialKey('llm-pi-ai', provider)
      const record = await credentials?.readRecord(key)
      if (record?.kind === 'grant') continue
      if (record !== undefined) {
        records[key] = { kind: record.kind, ...(record.key === undefined ? {} : { key: record.key }),
          ...(record.env === undefined ? {} : { env: record.env }) }
      }
    }
  }
  const reviewCredentials: Record<string, string> = {}
  if (Array.isArray(review?.evaluators)) for (const evaluator of review.evaluators) {
    if (evaluator === null || typeof evaluator !== 'object' || Array.isArray(evaluator) || typeof evaluator.credentialRef !== 'string') throw new TypeError('Invalid action evaluator credential reference')
    if (!evaluator.credentialRef) continue
    const resolved = await credentials?.resolve(credentialRef(evaluator.credentialRef))
    if (!resolved?.value) throw new Error(`Action reviewer credential is missing: ${evaluator.credentialRef}`)
    reviewCredentials[evaluator.credentialRef] = resolved.value
  }
  return { bundles, patches, credentials: { version: 1, refs, records }, reviewCredentials,
    trajectories: ctx.get('trajectoryCollector') !== undefined && ctx.get('trajectoryProjection') !== undefined }
}
