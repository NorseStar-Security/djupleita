/** Reconnaissance Service Definition; providers enforce authorization on every operation. */
import { Context, Service } from '@deepseek-ai/cordis'
import type { ReconCapability, ReconRequest, ReconResult } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    recon: Reconnaissance
  }
}

/** Structured failures deliberately exclude provider stderr and credentials. */
export class ReconError extends Error {
  constructor(readonly code: 'RECON_TARGET' | 'RECON_SCOPE' | 'RECON_ACTIVE' | 'RECON_OUTPUT' | 'RECON_PROCESS' | 'RECON_UNAVAILABLE', message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options)
    this.name = 'ReconError'
  }
}

/** Replaceable, session-free recon capability. */
export abstract class Reconnaissance extends Service {
  constructor(ctx: Context) { super(ctx, 'recon') }

  /**
   * Inspect supported operations without executing tools or making network requests.
   * @returns the passive-first operation catalog.
   */
  abstract catalog(): readonly ReconCapability[]

  /**
   * Run one authorized, bounded operation. Observations do not modify policy.
   * @param request - explicit targets, active consent, and resolved file policy.
   * @param signal - caller cancellation; rejection waits for child termination.
   * @returns the complete normalized inventory, never silently truncated output.
   * @throws ReconError for scope, dependency, subprocess, or output failures.
   */
  abstract run(request: ReconRequest, signal: AbortSignal): Promise<ReconResult>
}

export default Reconnaissance
