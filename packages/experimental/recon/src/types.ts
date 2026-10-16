/** Provider-independent reconnaissance requests and observations. */
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'

/** Supported bounded operations, not arbitrary command names. */
export type ReconComponent = 'subfinder' | 'urlfinder' | 'dnsx' | 'httpx' | 'naabu' | 'katana'

/** One available recon operation; availability of its executable is checked on use. */
export interface ReconCapability {
  readonly component: ReconComponent
  readonly mode: 'passive' | 'active'
  readonly input: 'domain' | 'url' | 'ip'
  readonly description: string
}

/** Fully specified operation; callers resolve session file policy before dispatch. */
export interface ReconRequest {
  readonly component: ReconComponent
  readonly targets: readonly string[]
  readonly allowActive: boolean
  readonly sandbox: SandboxExecutionPolicy
}

/** An observation never grants permission to contact the observed asset. */
export interface ReconObservation {
  readonly kind: 'domain' | 'url' | 'ip' | 'service'
  readonly value: string
  readonly source: ReconComponent
  readonly inScope: boolean
  /** DNS owner name supporting this specific address or alias observation. */
  readonly subject?: string
  readonly port?: number
  readonly status?: number
  readonly title?: string
  readonly technologies?: readonly string[]
}

/** Complete, bounded inventory from one successful subprocess. Failures return no partial inventory. */
export interface ReconResult {
  readonly component: ReconComponent
  readonly mode: 'passive' | 'active'
  readonly targets: readonly string[]
  readonly policyHash: string
  /** Upstream sources can be incomplete even when the CLI exits successfully. */
  readonly coverage: 'best-effort'
  /** Diagnostic text is not forwarded because it may contain credentials or response content. */
  readonly diagnosticsPresent: boolean
  readonly observations: readonly ReconObservation[]
}
