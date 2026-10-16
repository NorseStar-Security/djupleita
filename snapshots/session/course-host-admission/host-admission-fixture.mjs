/** Mount the actual web course admission owner in the shipped headless test profile. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const plane = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/index.js' : 'src/index.ts'
const root = new URL('../../../', import.meta.url)
const Runtime = await import(new URL(`packages/experimental/course-runtime/${plane}`, root).href)
const WebServer = await import(new URL(`packages/host/webserver/${plane}`, root).href)
const Connection = await import(new URL(`packages/client/connection/${plane}`, root).href)
const Credentials = await import(new URL(`packages/credentials/credentials-local/${plane}`, root).href)

export const inject = ['tools']
export async function apply(ctx) {
  await ctx.plugin(Credentials.default, { path: join(process.cwd(), '.dsh', 'course-host-credentials.yaml'), watch: false })
  await ctx.plugin(WebServer.default, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Connection)
  await ctx.plugin(Runtime, {
    role: 'instructor', sourceRoot: fileURLToPath(root),
    stateRoot: join(process.cwd(), '.dsh', 'course-host-admission'),
    dockerContext: 'fixture-never-connect', python: 'python3',
  })
}
