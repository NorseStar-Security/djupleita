/** Saved model authentication is selected by configured routes, never by enumerating host credentials. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import Credentials from '@deepseek-ai/dsh-credentials-local'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { nativeFeatures } from '../src/features.ts'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { vi.unstubAllEnvs(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })
class SettingsFixture extends Service {
  constructor(ctx: Context) { super(ctx, 'settings') }
  describe() { return [
    { ns: 'llm-pi-ai', value: { providers: { openai: { apiKeyEnv: 'MODEL_KEY' }, anthropic: { apiKeyEnv: 'AMBIENT_KEY' } } } },
    { ns: 'agent-default-model', value: { model: 'openai/gpt-fixture' } },
    { ns: 'unrelated-plugin', value: { apiKeyEnv: 'UNRELATED_KEY' } },
  ] }
}
class BundlesFixture extends Service {
  constructor(ctx: Context) { super(ctx, 'pluginManager') }
  listBundles() { return [{ name: 'base', enabled: true }, { name: 'auto-review', enabled: true }, { name: 'disabled', enabled: false }] }
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-features-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context(); cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(Credentials, { path: join(root, 'credentials.yaml'), watch: false })
  await ctx.plugin(SettingsFixture); await ctx.plugin(BundlesFixture)
  return ctx
}
it('selects stored API keys and configured model records while excluding host environment and unrelated secrets', async () => {
  const ctx = await fixture()
  vi.stubEnv('AMBIENT_KEY', 'fixture-ambient-excluded')
  await ctx.credentials.set(credentialRef('MODEL_KEY'), 'fixture-stored')
  await ctx.credentials.set(credentialRef('UNRELATED_KEY'), 'fixture-unrelated-excluded')
  await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'openai'), async () => ({ kind: 'api-key', key: 'fixture-record' }))
  await ctx.credentials.modifyRecord(credentialKey('other-plugin', 'secret'), async () => ({ kind: 'api-key', key: 'fixture-other-excluded' }))
  const features = await nativeFeatures(ctx)
  expect(features.bundles).toEqual(['base', 'auto-review'])
  expect(features.patches.map(row => row.id)).toEqual(['llm-pi-ai', 'agent-default-model'])
  expect(features.credentials).toEqual({ version: 1, refs: { MODEL_KEY: 'fixture-stored' }, records: { 'llm-pi-ai/openai': { kind: 'api-key', key: 'fixture-record' } } })
  expect(features.trajectories).toBe(false)
  expect(JSON.stringify(features)).not.toContain('excluded')
})
it('leaves account grants native while allowing independent Protected authentication', async () => {
  const ctx = await fixture()
  const key = credentialKey('llm-pi-ai', 'openai')
  await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { refreshToken: 'fixture-native-only' } }))
  expect((await nativeFeatures(ctx)).credentials.records).toEqual({})
  expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: { refreshToken: 'fixture-native-only' } })
})
it('resolves only explicitly configured reviewer credentials into a separate gateway-only field', async () => {
  const ctx = await fixture()
  vi.stubEnv('JUDGE_KEY', 'fixture-gateway-only')
  const features = await nativeFeatures(ctx, { evaluators: [{ credentialRef: 'JUDGE_KEY' }] })
  expect(features.reviewCredentials).toEqual({ JUDGE_KEY: 'fixture-gateway-only' })
  expect(JSON.stringify(features.credentials)).not.toContain('fixture-gateway-only')
  expect(JSON.stringify(features.patches)).not.toContain('fixture-gateway-only')
  await expect(nativeFeatures(ctx, { evaluators: [{ credentialRef: 'MISSING_JUDGE_KEY' }] })).rejects.toThrow('credential is missing')
})
