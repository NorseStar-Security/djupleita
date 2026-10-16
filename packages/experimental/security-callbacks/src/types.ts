/** Provider-independent HTTP callback evidence and correlation handles. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Unpredictable correlation handle; possession alone does not grant session access. */
export type CallbackId = Branded<'CallbackId'>
/** Consumer-owned identity, normally the initiating Session id. */
export type CallbackOwner = Branded<'CallbackOwner'>

/** Published tunnel owned by the caller until close settles. */
export interface CallbackTunnelLease {
  readonly url: string
  /** Stop publishing; failures must report an unknown remote cleanup outcome. */
  close(): Promise<void>
}

/** A callback URL usable until the absolute expiration time. */
export interface CallbackHandle {
  readonly id: CallbackId
  readonly url: string
  readonly expiresAt: string
}

/** Untrusted request evidence; body bytes are never decoded or executed. */
export interface CallbackEvent {
  readonly receivedAt: string
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | readonly string[]>>
  readonly bodyBase64: string
}

/** Complete retained evidence; dropped counts rejected requests, not confirmed vulnerabilities. */
export interface CallbackEvidence extends CallbackHandle {
  readonly events: readonly CallbackEvent[]
  readonly dropped: number
}
