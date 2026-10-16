/** Deterministic external-policy substitute; Compose owns real Linux enforcement tests. */
import NetworkScopePolicy from '@deepseek-ai/dsh-experimental-network-scope'
import type { ScopeTarget, ScopeInspection } from '@deepseek-ai/dsh-experimental-network-scope/types'

export default class SnapshotNetworkScope extends NetworkScopePolicy {
  override async inspect(_after: number | undefined, targets: readonly ScopeTarget[], signal: AbortSignal): Promise<ScopeInspection> {
    signal.throwIfAborted()
    return { protocol: 1, instance: 'course-snapshot-gateway', policyHash: 'a'.repeat(64), boundary: 'linux-netns-nftables', uid: 1000,
      healthy: true, policy: { domains: ['acme.test'], ips: ['198.18.0.2'] }, firstSeq: 0, nextSeq: 0, events: [],
      allowed: targets.every(target => new URL(target.url).hostname === 'acme.test'),
    }
  }
}
