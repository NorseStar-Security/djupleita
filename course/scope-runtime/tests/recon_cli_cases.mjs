/** Emit production adapter argv for the network-disabled Linux CLI smoke. */
import { argumentsFor, capabilities } from '../../../packages/experimental/recon-projectdiscovery/src/components.ts'

console.log(JSON.stringify(capabilities.map((capability) => {
  const target = capability.input === 'ip' ? '127.0.0.1' : capability.input === 'url' ? 'http://127.0.0.1:18080/' : 'example.test'
  return {
    name: capability.component, mode: capability.mode, target,
    args: argumentsFor(capability.component, [target], {
      proxy: 'http://127.0.0.1:18080', resolver: '127.0.0.1:15353', rate: 5, concurrency: 2, depth: 2,
      ports: [18080], home: '/tmp/recon-smoke-config', sources: { subfinder: ['crtsh'], urlfinder: ['waybackarchive'] }, responseMaxBytes: 1048576,
    }),
  }
})))
