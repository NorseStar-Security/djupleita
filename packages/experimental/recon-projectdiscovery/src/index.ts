/** Local Linux ProjectDiscovery provider. Compose in the gateway's UID/network namespace. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Reconnaissance, ReconError } from '@deepseek-ai/dsh-experimental-recon'
import type { ReconRequest, ReconResult } from '@deepseek-ai/dsh-experimental-recon/types'
import type {} from '@deepseek-ai/dsh-experimental-network-scope'
import type { SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type {} from '@deepseek-ai/dsh-sandbox'
import { argumentsFor, capabilities, capabilityByComponent, observationsFrom } from './components.ts'
import { normalizeTarget, TargetScope } from './scope.ts'

/** Instructor-owned tools and resource budgets. Binaries are never downloaded at runtime. */
export interface Config {
  /** Executable paths or bare PATH names, provisioned and pinned by the instructor. */
  executables: {
    /** Passive subdomain enumerator. */
    subfinder: string
    /** Passive URL archive reader. */
    urlfinder: string
    /** DNS resolver. */
    dnsx: string
    /** ProjectDiscovery HTTP probe, not the Python HTTP library. */
    httpx: string
    /** TCP CONNECT scanner. */
    naabu: string
    /** Standard HTTP crawler. */
    katana: string
  }
  /** Course HTTP proxy; used explicitly even for CLIs that ignore proxy environment variables. */
  proxy: string
  /** Course DNS resolver for DNSx and HTTPx. */
  resolver: string
  /** Maximum submitted targets in one request, before deduplication. */
  maxTargets: number
  /** Whole operation deadline, including executable resolution and policy inspections. */
  timeoutMs: number
  /** Managed-process termination grace period. */
  graceMs: number
  /** Per-stream retained byte cap and complete serialized result byte cap. */
  maxBytes: number
  /** Maximum JSONL records and normalized observations. */
  maxRecords: number
  /** Per-process requests or packets per second; concurrent operations are rejected. */
  rate: number
  /** Per-process worker limit where supported. */
  concurrency: number
  /** Katana crawl depth. */
  depth: number
  /** Exact TCP ports Naabu may scan. */
  ports: number[]
  /** Explicit passive API sources; instructor policy must grant their operational API endpoints. */
  sources: {
    /** Reviewed Subfinder passive-source identifiers. */
    subfinder: string[]
    /** Reviewed URLfinder passive-source identifiers. */
    urlfinder: string[]
  }
  /** Maximum bytes Katana reads from one HTTP response. */
  responseMaxBytes: number
}

/** ProjectDiscovery CLI Service Provider; scope checks also protect direct service callers. */
export default class ProjectDiscoveryRecon extends Reconnaissance {
  static inject = ['networkScope', 'subprocess']
  static Config: z<Partial<Config>, Config> = z.object({
    executables: z.object({ subfinder: z.string().min(1).default('subfinder'), urlfinder: z.string().min(1).default('urlfinder'), dnsx: z.string().min(1).default('dnsx'), httpx: z.string().min(1).default('httpx'), naabu: z.string().min(1).default('naabu'), katana: z.string().min(1).default('katana') }).default({}),
    proxy: z.transform(z.string(), (value) => {
      const url = new URL(value)
      if (url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('recon proxy must be an HTTP proxy URL without credentials or a path')
      return url.href
    }).default('http://127.0.0.1:3128'),
    resolver: z.string().min(1).default('127.0.0.1'),
    maxTargets: z.natural().min(1).default(16),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(120000),
    graceMs: z.natural().min(1).max(2_147_483_647).default(1000),
    maxBytes: z.natural().min(1).default(1024 * 1024),
    maxRecords: z.natural().min(1).default(2000),
    rate: z.natural().min(1).default(5),
    concurrency: z.natural().min(1).default(2),
    depth: z.natural().min(1).default(2),
    ports: z.array(z.natural().min(1).max(65535)).min(1).default([80, 443]),
    sources: z.object({ subfinder: z.array(z.string().min(1)).min(1).default(['crtsh']), urlfinder: z.array(z.string().min(1)).min(1).default(['waybackarchive']) }).default({}),
    responseMaxBytes: z.natural().min(1).default(1024 * 1024),
  })

  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<ReconResult>>()

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx)
    if (!(ctx.subprocess instanceof LocalSubprocessRuntime)) throw new ReconError('RECON_UNAVAILABLE', 'This provider requires local subprocess execution in the course gateway namespace; remote executors are not supported.')
    ctx.effect(() => async () => {
      this.lifetime.abort()
      await Promise.allSettled(this.pending)
    })
  }

  override catalog() { return capabilities.map(value => ({ ...value })) }

  override async run(request: ReconRequest, signal: AbortSignal): Promise<ReconResult> {
    if (this.pending.size) throw new ReconError('RECON_UNAVAILABLE', 'Another recon operation is running; wait for it to finish.')
    const combined = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.config.timeoutMs)])
    combined.throwIfAborted()
    const task = this.execute(request, combined)
    this.pending.add(task)
    try { return await task } finally { this.pending.delete(task) }
  }

  private async execute(request: ReconRequest, signal: AbortSignal): Promise<ReconResult> {
    const capability = capabilityByComponent[request.component]
    if (capability.mode === 'active' && !request.allowActive) throw new ReconError('RECON_ACTIVE', 'Active recon requires allowActive=true and instructor-authorized targets.')
    if (!request.targets.length || request.targets.length > this.config.maxTargets) throw new ReconError('RECON_TARGET', `Provide 1–${this.config.maxTargets} targets.`)
    const targets = [...new Set(request.targets.map(target => normalizeTarget(target, capability.input)))]
    const before = await this.ctx.networkScope.inspect(undefined, [], signal)
    if (!before.healthy) throw new ReconError('RECON_SCOPE', 'The instructor gateway is unhealthy; no recon can run.')
    const scope = new TargetScope(before.policy)
    if (targets.some(target => !scope.allows(target))) throw new ReconError('RECON_SCOPE', 'A requested target is outside the instructor scope. Observations and infrastructure exceptions do not grant target access.')
    if (capability.input === 'url') {
      const check = await this.ctx.networkScope.inspect(undefined, targets.map(url => ({ url, method: 'GET' })), signal)
      if (!check.healthy || !check.allowed || check.instance !== before.instance || check.policyHash !== before.policyHash) throw new ReconError('RECON_SCOPE', 'The gateway denied a URL or changed identity.')
    }
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.executables[request.component], undefined, signal)
    signal.throwIfAborted()
    const home = await mkdtemp(join(tmpdir(), 'dsh-recon-'))
    try {
      await writeFile(join(home, 'config.yaml'), '{}\n', { mode: 0o600 })
      await writeFile(join(home, 'providers.yaml'), '{}\n', { mode: 0o600 })
      const argv = [executable, ...argumentsFor(request.component, targets, { ...this.config, home })]
      const sandbox = request.sandbox
      let command: readonly string[] = argv
      if (sandbox.mode !== 'danger-full-access') {
        const backend = this.ctx.get('sandbox')
        if (!backend) throw new ReconError('RECON_UNAVAILABLE', 'The requested file policy has no sandbox provider; recon did not run.')
        const confined = await backend.confine(argv, { ...sandbox, mode: sandbox.mode }, signal)
        if (confined.enforcement !== 'full') throw new ReconError('RECON_UNAVAILABLE', 'The requested file policy cannot be fully enforced; recon did not run.')
        command = confined.argv
      }
      signal.throwIfAborted()
      const child = this.ctx.subprocess.spawn({
        argv: command, cwd: home, signal, graceMs: this.config.graceMs,
        env: { HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, SUBFINDER_CONFIG: join(home, 'config.yaml'), SUBFINDER_PROVIDER_CONFIG: join(home, 'providers.yaml'),
          HTTP_PROXY: this.config.proxy, HTTPS_PROXY: this.config.proxy, ALL_PROXY: this.config.proxy,
          http_proxy: this.config.proxy, https_proxy: this.config.proxy, all_proxy: this.config.proxy, NO_PROXY: '', no_proxy: '',
          PDCP_API_KEY: undefined, SHODAN_API_KEY: undefined },
        stdio: { stdin: { data: capability.input === 'domain' && capability.mode === 'passive' ? '' : `${targets.join('\n')}\n` }, stdout: { maxBytes: this.config.maxBytes }, stderr: { maxBytes: this.config.maxBytes } },
      })
      try {
        const outcome = await child.done
        signal.throwIfAborted()
        if (outcome.exitCode !== 0 || outcome.signal !== null) throw new ReconError('RECON_PROCESS', `${request.component} failed (exit ${String(outcome.exitCode)}); ask the instructor to check the pinned CLI version and allowed source APIs.`)
        const stdout = (child.collected.stdout as SubprocessOutputReader).readFrom(0)
        const stderr = (child.collected.stderr as SubprocessOutputReader).readFrom(0)
        if (stdout.lossy || stderr.lossy) throw new ReconError('RECON_OUTPUT', 'The CLI exceeded its output budget; no partial inventory was accepted.')
        const after = await this.ctx.networkScope.inspect(undefined, [], signal)
        if (!after.healthy || after.instance !== before.instance || after.policyHash !== before.policyHash) throw new ReconError('RECON_SCOPE', 'The gateway became unavailable or changed; the inventory was not accepted.')
        const result: ReconResult = { component: request.component, mode: capability.mode, targets, policyHash: before.policyHash, coverage: 'best-effort', diagnosticsPresent: stderr.text.length > 0,
          observations: observationsFrom(stdout.text, request.component, scope, this.config.maxRecords) }
        if (Buffer.byteLength(JSON.stringify(result)) > this.config.maxBytes) throw new ReconError('RECON_OUTPUT', 'The complete inventory exceeds its byte budget; no partial inventory was accepted.')
        return result
      } finally {
        child.terminate()
        await child.waitForExit()
      }
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }
}
