/** All protected resources keep one backend and a separate browser credential. */
import { createServer } from 'node:http'
import { connect, type AddressInfo } from 'node:net'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { RuntimeController } from '../src/controller.ts'
import { proxyHttp, proxyUpgrade } from '../src/proxy.ts'

it('streams file/upload/RPC bodies and upgrades using only the protected credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-course-proxy-'))
  const upstream = createServer((req, res) => {
    void (async () => {
      if (req.url?.startsWith('/?token=')) { res.writeHead(303, { 'set-cookie': 'research=separate; HttpOnly', location: './' }); res.end(); return }
      let body = ''
      for await (const part of req) body += Buffer.isBuffer(part) ? part.toString() : String(part)
      res.setHeader('content-type', 'application/json')
      res.setHeader('set-cookie', 'research=must-not-reach-browser')
      res.end(JSON.stringify({ host: req.headers.host, origin: req.headers.origin, url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, forwarded: req.headers['x-forwarded-for'], body }))
    })().catch((error: unknown) => { res.destroy(error instanceof Error ? error : new Error(String(error))) })
  })
  let upgradeCookie: string | undefined
  upstream.on('upgrade', (req, socket, head) => {
    upgradeCookie = req.headers.cookie
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n')
    if (head.length) socket.write(head)
    socket.on('data', (data) => { socket.write(data) })
    socket.on('end', () => { socket.destroy() })
  })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const controller = new RuntimeController({
    sourceRoot: resolve('.'), stateRoot: root, dockerContext: 'unused', python: 'python3', operationTimeoutMs: 10000,
  }, 'http://127.0.0.1:3080/')
  const native = createServer((req, res) => { void proxyHttp(controller, req, res) })
  native.on('upgrade', (req, socket, head) => { void proxyUpgrade(controller, req, socket, head) })
  native.listen(0, '127.0.0.1'); await once(native, 'listening')
  onTestFinished(async () => {
    native.closeAllConnections(); upstream.closeAllConnections()
    await Promise.all([
      new Promise<void>(r => native.close(() => { r() })), new Promise<void>(r => upstream.close(() => { r() })),
    ])
    await rm(root, { recursive: true, force: true })
  })
  await writeFile(join(root, 'backend.json'), JSON.stringify({ origin: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, token: 'research-launch-token' }))
  const origin = `http://127.0.0.1:${(native.address() as AddressInfo).port}`
  for (const path of ['/api', '/api/files/content?path=one', '/api/attachments/upload', '/client/example.js']) {
    const response = await fetch(`${origin}/runtimes/course${path}`, { method: 'POST', headers: { cookie: 'native=secret', authorization: 'Bearer native-secret', 'x-forwarded-for': 'host-secret' }, body: 'fixture-bytes' })
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toEqual({ host: `127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      origin: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, url: path, cookie: 'research=separate', body: 'fixture-bytes' })
  }
  const socket = connect((native.address() as AddressInfo).port, '127.0.0.1')
  onTestFinished(() => { socket.destroy() })
  await once(socket, 'connect')
  const result = once(socket, 'data')
  socket.write('GET /runtimes/course/api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: native=secret\r\nSec-WebSocket-Key: test\r\nSec-WebSocket-Version: 13\r\n\r\n')
  expect(String((await result)[0])).toContain('101')
  expect(upgradeCookie).toBe('research=separate')
  const echo = once(socket, 'data'); socket.write('stream-fixture'); expect(String((await echo)[0])).toBe('stream-fixture')
  socket.destroy()
})
