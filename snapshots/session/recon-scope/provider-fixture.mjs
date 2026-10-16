/** External gateway substitute; select one source/artifact plane with the snapshot launcher. */
const plane = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
const { default: NetworkScopePolicy } = await import(new URL(`../../../packages/experimental/network-scope/${plane}`, import.meta.url).href)

export default class ReconSnapshotScope extends NetworkScopePolicy {
  async inspect(_after, targets, signal) {
    signal.throwIfAborted()
    return {
      protocol: 1, instance: 'recon-fixture-gateway', policyHash: 'a'.repeat(64), boundary: 'linux-netns-nftables', uid: 1000,
      healthy: true, policy: { domains: ['example.test'], ips: [] }, firstSeq: 0, nextSeq: 0, events: [],
      allowed: targets.every(target => new URL(target.url).hostname === 'example.test'),
    }
  }
}
