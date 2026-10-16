/** Import native model settings without replacing deliberate Protected edits or unrelated credentials. */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

function mapping(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }

function inherit(native, current, previous) {
  if (current === undefined || isDeepStrictEqual(current, previous)) return structuredClone(native)
  if (!mapping(native) || !mapping(current)) return current
  const result = { ...current }
  for (const key of new Set([...Object.keys(native), ...Object.keys(previous ?? {})])) {
    if (!Object.hasOwn(native, key)) {
      if (isDeepStrictEqual(current[key], previous?.[key])) delete result[key]
      continue
    }
    result[key] = inherit(native[key], current[key], mapping(previous) ? previous[key] : undefined)
  }
  return result
}

/**
 * Seed selected native features into one stopped backend's private home; only prior inherited values are refreshed.
 * @param sourceRoot - installed harness repository used to resolve its YAML dependency.
 * @param home - Protected DSH home, never the Mac home.
 * @param features - private native launch snapshot.
 * @returns fulfillment after owner-only atomic writes finish.
 */
export async function importFeatures(sourceRoot, home, features) {
  const { parse, parseDocument, isSeq, isAlias, visit, stringify } = createRequire(join(sourceRoot, 'packages/boot/config-editor/package.json'))('yaml')
  const read = async (path, fallback) => {
    try { return parse(await readFile(path, 'utf8')) ?? fallback }
    catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('Protected configuration could not be read; source values are not logged.') }
  }
  const write = async (path, value) => {
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 })
    await writeFile(`${path}.tmp`, path.endsWith('.json') ? `${JSON.stringify(value, null, 2)}\n` : stringify(value), { mode: 0o600 })
    await rename(`${path}.tmp`, path)
  }
  const previousPath = join(home, '.course-native-import.yaml')
  const previous = await read(previousPath, { patches: [], credentials: { refs: {}, records: {} }, bundles: [] })
  const patchPath = join(home, 'profiles/web/cordis.patch.yml')
  let patchText = '[]'
  try { patchText = await readFile(patchPath, 'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const patches = parseDocument(patchText)
  if (patches.errors.length || !isSeq(patches.contents)) throw new Error('Protected profile patch must be a valid sequence')
  for (const patch of features.patches) {
    const existing = patches.contents.items.findLastIndex(row => row?.get?.('id') === patch.id && !row.has('insert'))
    const before = previous.patches.find(row => row.id === patch.id)
    if (existing >= 0) {
      const node = patches.getIn([existing, 'config'], true)
      let expression = false
      visit(node, (_key, child) => { if (child?.tag || isAlias(child)) expression = true })
      // Explicit executable or aliased Protected configuration retains its original YAML semantics.
      if (expression) continue
      patches.setIn([existing, 'config'], inherit(patch.config, node?.toJSON(), before?.config))
    } else patches.add(patch)
  }
  const credentialsPath = join(home, '.credentials.yaml')
  const credentials = await read(credentialsPath, { version: 1, refs: {}, records: {} })
  if (credentials.version !== 1) throw new Error('Protected credentials require the current versioned format')
  credentials.refs = inherit(features.credentials.refs, credentials.refs ?? {}, previous.credentials.refs)
  credentials.records = inherit(features.credentials.records, credentials.records ?? {}, previous.credentials.records)
  const manifestPath = join(home, 'profiles/web/package.json')
  const manifest = await read(manifestPath, { name: 'dsh-profile-web', private: true, dependencies: {} })
  const selected = manifest.dsh?.profile?.bundles ?? []
  const ownBundles = selected.filter(name => !previous.bundles.includes(name))
  manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile,
    bundles: [...new Set([...features.bundles, ...ownBundles])] } }
  await mkdir(resolve(patchPath, '..'), { recursive: true, mode: 0o700 })
  await writeFile(`${patchPath}.tmp`, String(patches), { mode: 0o600 })
  await rename(`${patchPath}.tmp`, patchPath)
  await write(credentialsPath, credentials)
  await write(manifestPath, manifest)
  await write(previousPath, features)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await importFeatures(process.argv[2], process.argv[3], JSON.parse(await readFile(process.argv[4], 'utf8')))
  } catch {
    process.stderr.write('Protected feature import failed. Review the private profile configuration; no credential values were logged.\n')
    process.exitCode = 1
  }
}
