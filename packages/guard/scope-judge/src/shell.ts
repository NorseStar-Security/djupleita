/** A deliberately finite Bash grammar; unsupported syntax cannot establish a destination. */
import { dnsName, targetDomain } from './domain.ts'

/** Result of interpreting a literal research command before any shell executes. */
export type ShellTargets = { targets: string[] } | { reason: string }

/** Tokenize literal words and quotes; expansions, operators, escapes, and control bytes are denied. */
function words(command: string): string[] | undefined {
  const result: string[] = []
  let word = ''
  let quote = ''
  let started = false
  for (const char of command) {
    if (/[\x00-\x08\x0a-\x1f\x7f$`\\]/u.test(char)) return undefined
    if (quote !== '') {
      if (char === quote) quote = ''
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (char === ' ' || char === '\t') {
      if (started) result.push(word)
      word = ''
      started = false
    } else {
      if (/[;&|<>(){}\[\]*?!~#]/u.test(char)) return undefined
      word += char
      started = true
    }
  }
  if (quote !== '') return undefined
  if (started) result.push(word)
  return result
}

/** Extract URLs only from curl options whose destination behavior is known. */
function curlTargets(args: string[]): string[] | undefined {
  // curl reads ~/.curlrc unless this is its first option.
  if (args[0] !== '-q' && args[0] !== '--disable') return undefined
  const flags = new Set(['-I', '--head', '-i', '--include', '-s', '--silent', '-S', '--show-error', '-v', '--verbose', '--compressed', '--http1.1', '--http2'])
  const targets: string[] = []
  let positional = false
  const options = args.slice(1).values()
  for (const arg of options) {
    if (!positional && arg === '--') { positional = true; continue }
    if (!positional && flags.has(arg)) continue
    if (!positional && arg === '--url') {
      const value = options.next().value
      if (value === undefined || !/^https?:\/\//iu.test(value) || targetDomain(value) === undefined) return undefined
      targets.push(value)
      continue
    }
    if (!positional && ['--connect-timeout', '--max-time', '-m'].includes(arg)) {
      const value = options.next().value
      if (value === undefined || !/^[0-9]+(?:\.[0-9]+)?$/u.test(value)) return undefined
      continue
    }
    if (!positional && ['-X', '--request'].includes(arg)) {
      if (!['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(options.next().value ?? '')) return undefined
      continue
    }
    if (!positional && ['-d', '--data', '--data-raw'].includes(arg)) {
      const value = options.next().value
      if (value === undefined || value.startsWith('@')) return undefined
      continue
    }
    if (!/^https?:\/\//iu.test(arg) || targetDomain(arg) === undefined) return undefined
    targets.push(arg)
  }
  return targets.length === 0 ? undefined : targets
}

/** Extract literal nmap host targets, excluding scripts, input files, ranges, and destination overrides. */
function nmapTargets(args: string[]): string[] | undefined {
  const flags = new Set(['-sT', '-sS', '-sU', '-sV', '-sn', '-Pn', '-n', '-O', '--open', '--reason', '-v', '-vv'])
  const targets: string[] = []
  const options = args.values()
  for (const arg of options) {
    if (flags.has(arg) || /^-T[0-5]$/u.test(arg)) continue
    if (arg === '-p') {
      const value = options.next().value
      if (value === undefined || !/^[0-9]+(?:-[0-9]+)?(?:,[0-9]+(?:-[0-9]+)?)*$/u.test(value)
        || value.split(/[,-]/u).some(port => Number(port) < 1 || Number(port) > 65535)) return undefined
      continue
    }
    if (arg === '--top-ports' || arg === '--max-retries') {
      const value = options.next().value
      if (value === undefined || !/^[0-9]+$/u.test(value) || Number(value) > 65535) return undefined
      continue
    }
    if (dnsName(arg) === undefined) return undefined
    targets.push(arg)
  }
  return targets.length === 0 ? undefined : targets
}

/** Extract one dig query name; the ordinary configured resolver is infrastructure, not a research target. */
function digTargets(args: string[]): string[] | undefined {
  // -r suppresses ~/.digrc; +trace, @server, batch files, and reverse-IP queries are excluded.
  if (args[0] !== '-r' || args[1] === undefined || dnsName(args[1]) === undefined) return undefined
  const rest = args.slice(2)
  const recordType = rest[0]
  if (recordType !== undefined && /^[A-Z]+$/u.test(recordType)) {
    if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SOA', 'CAA', 'SRV', 'ANY'].includes(recordType)) return undefined
    rest.shift()
  }
  if (!rest.every(arg => ['+short', '+noall', '+answer', '+comments', '+tcp', '+dnssec'].includes(arg))) return undefined
  return [args[1]]
}

/**
 * Interpret the supported one-shot command subset without executing anything.
 * @param command - Bash command containing only literal words and quotes.
 * @returns every explicit destination, or a denial reason for unsupported syntax/options.
 */
export function shellTargets(command: string): ShellTargets {
  const tokens = words(command)
  if (tokens === undefined) return { reason: 'shell expansion, operators, escapes, or control characters are not supported' }
  const [program, ...args] = tokens
  let targets: string[] | undefined
  if (program === 'curl') targets = curlTargets(args)
  else if (program === 'nmap') targets = nmapTargets(args)
  else if (program === 'dig') targets = digTargets(args)
  if (targets === undefined) return { reason: 'use a supported literal curl -q, nmap, or dig -r command; options that hide or change destinations are denied' }
  return { targets }
}
