/** Native model import refreshes inherited values without rewriting Protected customizations. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const { parse } = createRequire(new URL('../../../packages/boot/config-editor/package.json', import.meta.url))('yaml')
import { importFeatures } from '../bootstrap.mjs'

test('inherits selected features, rotates/removes inherited keys and retains private Protected overrides and YAML tags', async t => {
  const home = await mkdtemp(join(tmpdir(), 'protected-import-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  const patchPath = join(home, 'profiles/web/cordis.patch.yml')
  await writeFile(patchPath, '- id: custom\n  config:\n    expression: !!js process.platform\n')
  const input = { bundles: ['base', 'auto-review'], trajectories: true,
    patches: [{ id: 'llm-pi-ai', config: { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } } }],
    credentials: { version: 1, refs: { OPENAI_API_KEY: 'fixture-one', DEEPSEEK_API_KEY: 'fixture-remove' }, records: { 'llm-pi-ai/openai': { kind: 'api-key', key: 'fixture-record-one' } } } }
  await importFeatures(resolve('.'), home, input)
  const patches = parse(await readFile(patchPath, 'utf8'), { logLevel: 'silent' })
  assert.equal(patches[1].config.providers.openai.apiKeyEnv, 'OPENAI_API_KEY')
  assert.match(await readFile(patchPath, 'utf8'), /!!js process.platform/)
  const credentialsPath = join(home, '.credentials.yaml')
  const credentials = parse(await readFile(credentialsPath, 'utf8'))
  credentials.refs.OPENAI_API_KEY = 'protected-override'
  credentials.refs.UNRELATED_SECRET = 'protected-only'
  await writeFile(credentialsPath, JSON.stringify(credentials))
  input.credentials.records['llm-pi-ai/openai'].key = 'fixture-record-two'
  input.credentials.refs = { OPENAI_API_KEY: 'fixture-two', NEW_KEY: 'fixture-new' }
  await importFeatures(resolve('.'), home, input)
  const refreshed = parse(await readFile(credentialsPath, 'utf8'))
  assert.deepEqual(refreshed.refs, { OPENAI_API_KEY: 'protected-override', UNRELATED_SECRET: 'protected-only', NEW_KEY: 'fixture-new' })
  assert.equal(refreshed.records['llm-pi-ai/openai'].key, 'fixture-record-two')
  assert.equal((await stat(credentialsPath)).mode & 0o777, 0o600)
  const manifest = JSON.parse(await readFile(join(home, 'profiles/web/package.json'), 'utf8'))
  assert.deepEqual(manifest.dsh.profile.bundles, ['base', 'auto-review'])
})

test('rejects malformed profiles before changing stored credentials', async t => {
  const home = await mkdtemp(join(tmpdir(), 'protected-import-invalid-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  await writeFile(join(home, 'profiles/web/cordis.patch.yml'), 'invalid: mapping')
  await assert.rejects(importFeatures(resolve('.'), home, { patches: [], credentials: { version: 1, refs: {}, records: {} }, bundles: [] }), /sequence/)
  await assert.rejects(readFile(join(home, '.credentials.yaml')), { code: 'ENOENT' })
})


test('keeps explicit executable Protected model configuration intact', async t => {
  const home = await mkdtemp(join(tmpdir(), 'protected-import-expression-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  await mkdir(join(home, 'profiles/web'), { recursive: true })
  const path = join(home, 'profiles/web/cordis.patch.yml')
  await writeFile(path, '- id: llm-pi-ai\n  config: !!js "({providers: {}})"\n')
  await importFeatures(resolve('.'), home, { patches: [{ id: 'llm-pi-ai', config: { providers: { openai: {} } } }],
    credentials: { version: 1, refs: {}, records: {} }, bundles: [] })
  assert.match(await readFile(path, 'utf8'), /!!js/)
})
