/** Provider-independent destination inspection and environment audit contract. */
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/** One HTTP(S) destination whose arguments can be inspected before dispatch. */
export interface ScopeTarget {
  readonly url: string
  readonly method: string
}

/** Environment-wide gateway record, deliberately without tool or Session attribution. */
export interface ScopeNetworkEvent {
  readonly seq: number
  readonly time: string
  readonly event: string
  readonly policy: string
  readonly [field: string]: JsonValue
}

/** Atomic observation of one immutable instructor policy and bounded audit feed. */
export interface ScopeInspection {
  readonly protocol: 1
  readonly instance: string
  readonly policyHash: string
  readonly boundary: 'linux-netns-nftables'
  readonly uid: 1000
  readonly healthy: boolean
  readonly policy: JsonValue
  readonly firstSeq: number
  readonly nextSeq: number
  readonly events: readonly ScopeNetworkEvent[]
  readonly allowed: boolean
}
