/** Opt-in public delivery test against an operator-owned authenticated ngrok agent. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { brandString } from '@deepseek-ai/dsh-brand'
import SecurityCallbacks from '@deepseek-ai/dsh-experimental-security-callbacks'
import type { CallbackOwner } from '@deepseek-ai/dsh-experimental-security-callbacks/types'
import NgrokCallbackTunnel from '../src/index.ts'

it.skipIf(!process.env.DSH_CALLBACK_PUBLIC_URL)('receives a public HTTPS callback through the real ngrok Agent endpoints API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'callback-live-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    Object.assign(ctx.loader.builtins, { include: Include, ngrok: NgrokCallbackTunnel, receiver: SecurityCallbacks })
    const file = join(root, 'cordis.yml')
    await writeFile(file, JSON.stringify([
      { name: 'cordis:ngrok', config: { publicUrl: process.env.DSH_CALLBACK_PUBLIC_URL, agentApi: process.env.DSH_CALLBACK_NGROK_AGENT_API ?? 'http://127.0.0.1:4040/api' } },
      { name: 'cordis:receiver' },
    ]))
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
    await ctx.loader.await()
    const owner = brandString<CallbackOwner>('live-test')
    const handle = await ctx.securityCallbacks.create(owner, AbortSignal.timeout(20000))
    const response = await fetch(handle.url, { method: 'POST', body: 'DSH_CALLBACK_LIVE', redirect: 'error', signal: AbortSignal.timeout(20000) })
    expect(response.status).toBe(204)
    const evidence = ctx.securityCallbacks.read(owner, handle.id)
    expect(evidence.events).toHaveLength(1)
    expect(evidence.events[0]!.bodyBase64).toBe(Buffer.from('DSH_CALLBACK_LIVE').toString('base64'))
    ctx.securityCallbacks.close(owner, handle.id)
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}, 60000)
