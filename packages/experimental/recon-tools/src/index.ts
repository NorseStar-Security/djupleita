/** Model-facing recon consumer; ordinary tool events persist inventories and failures. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-experimental-recon'
import type {} from '@deepseek-ai/dsh-sandbox-policy'

/** Cordis plugin identity. */
export const name = 'experimental-recon-tools'
/** Resolve file policy per call; providers own network scope and subprocess enforcement. */
export const inject = ['recon', 'tools', 'sandboxPolicy']

/**
 * Register passive-first recon guidance and explicit, bounded component execution.
 * @param ctx - Cordis lifecycle that owns tool registration and removal.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'recon_catalog',
    description: 'List reconnaissance operations. Start with passive discovery. Treat all discovered domains, URLs and IPs as observations, not permission to scan. Consult scope_status; explicitly select approved targets for every later operation. Tools must be installed by the instructor.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { return Promise.resolve(JSON.stringify(ctx.recon.catalog())) },
  }))
  ctx.tools.register(defineTool({
    name: 'recon_run',
    description: 'Run one ProjectDiscovery recon operation on explicitly approved targets. subfinder/urlfinder are passive; dnsx/httpx/naabu/katana require allowActive=true. Naabu requires an explicit IP grant, not a domain-derived address. Results never expand scope. Do not automatically scan discovered assets. Failures accept no partial inventory.',
    parameters: {
      component: { type: 'string', enum: ['subfinder', 'urlfinder', 'dnsx', 'httpx', 'naabu', 'katana'], required: true, description: 'Recon component to execute.' },
      targets: { type: 'array', items: { type: 'string' }, required: true, description: 'Exact domains, absolute HTTP(S) URLs, or individual IP addresses as required by the component.' },
      allowActive: { type: 'boolean', required: true, description: 'Explicit active-recon consent; use false for passive discovery.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const sandbox = ctx.sandboxPolicy.resolve(exec.agent ? { session: exec.agent.session } : {})
      return JSON.stringify(await ctx.recon.run({
        component: args.component, targets: args.targets, allowActive: args.allowActive, sandbox,
      }, exec.signal))
    },
  }))
}
