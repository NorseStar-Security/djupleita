/** No tunnel is opened for the unknown-handle evidence test. */
const plane = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
const { CallbackTunnel } = await import(new URL(`../../../packages/experimental/security-callbacks/${plane}`, import.meta.url).href)
export default class SnapshotTunnel extends CallbackTunnel {
  async open() { throw new Error('This scenario must not publish an endpoint.') }
}
