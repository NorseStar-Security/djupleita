/** Preflight the trusted local collection deployment, then preserve the ordinary dsh process contract. */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repository = fileURLToPath(new URL('../..', import.meta.url))
const bin = resolve(repository, 'apps/cli/lib/bin.js')
const overlay = fileURLToPath(new URL('./native.overlay.yml', import.meta.url))

function inside(root, target) {
  const child = relative(root, target)
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`))
}

/** Reject missing identity or unsafe lexical path placement without printing deployment values. */
export function validateEnvironment(env) {
  for (const name of ['COURSE_INSTALLATION_ID', 'COURSE_STUDENT_ID', 'COURSE_COHORT_ID']) {
    const value = env[name]
    // oxlint-disable-next-line no-control-regex -- Deployment identity explicitly rejects control characters.
    if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value) > 128 || /[\u0000-\u001f\u007f]/u.test(value)) {
      throw new Error(`${name} must contain an instructor-assigned label of at most 128 UTF-8 bytes, without control characters.`)
    }
  }
  for (const name of ['DSH_HOME', 'COURSE_COLLECTOR_DB', 'COURSE_PROJECTION_DB']) {
    if (typeof env[name] !== 'string' || !isAbsolute(env[name])) throw new Error(`${name} must be an explicit absolute path.`)
  }
  const home = resolve(env.DSH_HOME)
  const collector = resolve(env.COURSE_COLLECTOR_DB)
  const projection = resolve(env.COURSE_PROJECTION_DB)
  if (inside(home, collector) || inside(home, projection)) throw new Error('Collector and projection archives must be outside DSH_HOME.')
  if (dirname(collector) === dirname(projection)) throw new Error('Collector and projection archives require separate dedicated directories.')
}

/** Launch the built CLI with one additive overlay; forward signals and await the owned child before returning. */
export async function run(args, env = process.env) {
  validateEnvironment(env)
  for (const path of [bin, ...['trajectory-collector-sqlite', 'trajectory-collector-archive', 'trajectory-projection', 'trajectory-viewer', 'trajectory-collector-http']
    .map(name => resolve(repository, 'packages/experimental', name, 'lib/index.js'))]) {
    try { await access(path) } catch { throw new Error('Build current CLI and trajectory plugin artifacts before launching local collection.') }
  }
  // The core CLI recognizes a shorthand profile only in argv[0]. Keep it there
  // while applying our overlay before the caller's explicit override patches.
  const first = args[0]
  const invocation = first !== undefined && !first.startsWith('-') && first !== 'plugin'
    ? [first, '--patch', overlay, ...args.slice(1)]
    : ['--patch', overlay, ...args]
  const child = spawn(process.execPath, [bin, ...invocation], { env, stdio: 'inherit' })
  let stopping = false
  let force
  const forward = (signal) => {
    if (stopping) return
    stopping = true
    child.kill(signal)
    force = setTimeout(() => { child.kill('SIGKILL') }, 15000)
  }
  const term = () => { forward('SIGTERM') }
  const interrupt = () => { forward('SIGINT') }
  process.on('SIGTERM', term)
  process.on('SIGINT', interrupt)
  try {
    const result = await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { accept({ code, signal }) })
    })
    return result.code ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1)
  } finally {
    clearTimeout(force)
    process.off('SIGTERM', term)
    process.off('SIGINT', interrupt)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await run(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write(`Local collection did not start: ${error instanceof Error ? error.message : 'preflight or process startup failed.'}\n`)
    process.exitCode = 1
  }
}
