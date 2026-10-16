/** Compile instructor configuration into a fail-closed, synchronous tool judge. */
import type { ToolGuard } from '@deepseek-ai/dsh-tools'
import type { Config } from './index.ts'
import { domainRules, inScope, targetDomain } from './domain.ts'
import { shellTargets } from './shell.ts'

/** Decode a JSON pointer; `*` explicitly selects every member of a nonempty array. */
function pointer(path: string): string[] {
  if (!path.startsWith('/') || /~(?![01])/u.test(path)) throw new Error(`scope-judge: invalid target pointer ${JSON.stringify(path)}`)
  return path.slice(1).split('/').map(part => part.replace(/~1/gu, '/').replace(/~0/gu, '~'))
}

/** Read all selected strings; missing, empty, non-string, and mixed array values deny the call. */
function readTargets(args: unknown, path: readonly string[]): string[] | undefined {
  let values: unknown[] = [args]
  for (const part of path) {
    const next: unknown[] = []
    for (const value of values) {
      if (part === '*') {
        if (!Array.isArray(value) || value.length === 0) return undefined
        const members: unknown[] = value
        next.push(...members)
      } else {
        if (typeof value !== 'object' || value === null || !Object.hasOwn(value, part)) return undefined
        next.push((value as Record<string, unknown>)[part])
      }
    }
    values = next
  }
  if (!values.every((value): value is string => typeof value === 'string' && value.length > 0)) return undefined
  return values
}

/**
 * Validate all scope and adapter fields before creating the immutable policy.
 * @param config - validated parser-level configuration supplied by the instructor.
 * @returns a monotonic guard; undefined abstains, a reason denies before dispatch.
 */
export function createJudge(config: Config): ToolGuard {
  const rules = domainRules(config.domains)
  const labels = rules.map(rule => `${rule.descendants ? '*.' : ''}${rule.domain}`).join(', ')
  const targetTools = new Map<string, string[][]>()
  const shellTools = new Set(config.shellTools)
  const localTools = new Set(config.localTools)
  const names = new Set<string>()
  for (const tool of config.targetTools ?? [{ name: 'web_fetch', paths: ['/url'] }]) {
    if (tool.paths.length === 0) throw new Error(`scope-judge: target tool ${JSON.stringify(tool.name)} needs at least one target pointer`)
    if (names.has(tool.name)) throw new Error(`scope-judge: duplicate tool ${JSON.stringify(tool.name)}`)
    names.add(tool.name)
    targetTools.set(tool.name, tool.paths.map(pointer))
  }
  for (const tool of [...config.shellTools ?? [], ...config.localTools ?? []]) {
    if (names.has(tool)) throw new Error(`scope-judge: duplicate or conflicting tool ${JSON.stringify(tool)}`)
    names.add(tool)
  }
  for (const tool of names) {
    if (tool.length === 0 || tool !== tool.trim()) throw new Error('scope-judge: tool names must be nonempty and have no surrounding whitespace')
  }
  return (exec) => {
    const deny = (reason: string): string => `scope judge denied ${JSON.stringify(exec.name)}: ${reason}. Allowed domains: ${labels}`
    if (localTools.has(exec.name)) return undefined
    let targets: string[]
    if (shellTools.has(exec.name)) {
      if (typeof exec.arguments !== 'object' || exec.arguments === null || !('command' in exec.arguments)
        || typeof exec.arguments.command !== 'string') return deny('a literal command string is required')
      // No stdin, env, or provider-specific alternate execution fields may bypass the command adapter.
      const knownFields = new Set(['command', 'description', 'timeoutMs', 'workdir', 'run_in_background', 'sandbox_permissions', 'justification'])
      if (Object.keys(exec.arguments).some(key => !knownFields.has(key))) return deny('unreviewed shell argument fields')
      const result = shellTargets(exec.arguments.command)
      if ('reason' in result) return deny(result.reason)
      targets = result.targets
    } else {
      const paths = targetTools.get(exec.name)
      if (paths === undefined) return deny('no reviewed target adapter or local-tool classification')
      targets = []
      for (const path of paths) {
        const selected = readTargets(exec.arguments, path)
        if (selected === undefined) return deny('a required target is missing, empty, or malformed')
        targets.push(...selected)
      }
    }
    for (const target of targets) {
      const domain = targetDomain(target)
      if (domain === undefined) return deny('a target is not an unambiguous DNS host or HTTP(S) URL')
      if (!inScope(domain, rules)) return deny(`target domain ${JSON.stringify(domain)} is outside scope`)
    }
    return undefined
  }
}
