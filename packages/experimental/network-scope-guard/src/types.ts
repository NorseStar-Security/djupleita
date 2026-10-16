/** Experimental log-only records; old readers retain and skip them. */
import type { ScopeNetworkEvent } from '@deepseek-ai/dsh-experimental-network-scope/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    /** Policy identity observed for this environment, never model instructions. */
    'plugin:network-scope-guard/boundary': {
      instance: string
      policyHash: string
      boundary: string
      attribution: 'shared-environment'
    }
    /** Environment traffic, not evidence that a particular tool caused it. */
    'plugin:network-scope-guard/network': {
      instance: string
      attribution: 'shared-environment'
      event: ScopeNetworkEvent
    }
    /** Actual pre-dispatch scope decision, linked only to the pending tool call. */
    'plugin:network-scope-guard/judge': {
      callId: string
      tool: string
      allowed: boolean
      code: 'SCOPE_READY' | 'SCOPE_DENIED' | 'SCOPE_INVALID_TARGET' | 'SCOPE_UNAVAILABLE'
    }
    /** Visible degradation; no claim that earlier traffic was attributed or recovered. */
    'plugin:network-scope-guard/unavailable': { code: string }
  }
}
