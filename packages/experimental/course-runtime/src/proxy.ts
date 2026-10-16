/** Authenticated native transport bridge. The only upstream credentials belong to research. */
import { request, type IncomingMessage, type ServerResponse, type OutgoingHttpHeaders } from 'node:http'
import type { Duplex } from 'node:stream'
import type { RuntimeController } from './controller.ts'

/** Headers accepted from the browser; cookie, authorization and forwarding headers are deliberately absent. */
const allowed = ['accept', 'accept-language', 'content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since',
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions']

/** Produce isolated upstream headers for either HTTP or its WebSocket upgrade. */
function headers(req: IncomingMessage, cookie: string, authority: string, upgrade: boolean): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = { host: authority, cookie, origin: `http://${authority}` }
  for (const key of allowed) if (req.headers[key] !== undefined) result[key] = req.headers[key]
  if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket' }
  return result
}

/** Stream every protected resource through the same transport, including files and terminals.
 * @param controller - Native owner of the private relay credentials.
 * @param req - Already authenticated native request.
 * @param res - Native browser response. */
export async function proxyHttp(
  controller: RuntimeController, req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  try {
    const backend = await controller.backendCookie()
    const path = (req.url ?? '/').slice('/runtimes/course'.length) || '/'
    const url = new URL(path, backend.origin)
    // Relative resolution must not permit a scheme-relative upstream escape.
    if (url.origin !== backend.origin) throw new Error('Invalid protected route')
    const options = { method: req.method, headers: headers(req, backend.cookie, new URL(backend.origin).host, false) }
    const upstream = request(url, options, (response) => {
      res.statusCode = response.statusCode ?? 502
      for (const [key, value] of Object.entries(response.headers)) {
        if (value === undefined || ['set-cookie', 'connection', 'transfer-encoding'].includes(key)) continue
        if (key === 'location' && typeof value === 'string' && value.startsWith('/')) res.setHeader(key, `/runtimes/course${value}`)
        else res.setHeader(key, value)
      }
      response.on('error', () => { res.destroy() })
      response.pipe(res)
    })
    upstream.on('error', () => { if (!res.headersSent) { res.statusCode = 502; res.end('Isolated backend unavailable. Return to Host management and review Network Scope.') } else res.destroy() })
    res.on('close', () => { upstream.destroy() })
    req.pipe(upstream)
  } catch {
    res.statusCode = 503
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end('<!doctype html><meta charset="utf-8"><title>Isolated runtime stopped</title><h1>Isolated runtime unavailable</h1><p>Research remains stopped. Return to Host management, open Plugins → Network Scope, and review the runtime error before applying.</p><a href="/?course-management=1">Return to Host management</a><button onclick="location.reload()">Retry isolated runtime</button>')
  }
}

/** Bridge the Gateway's multiplexed WebSocket with backpressure and symmetric disconnect.
 * @param controller - Native owner of the private relay credentials.
 * @param req - Already authenticated upgrade request.
 * @param socket - Native browser stream.
 * @param head - Initial browser stream bytes. */
export async function proxyUpgrade(
  controller: RuntimeController, req: IncomingMessage, socket: Duplex, head: Buffer,
): Promise<void> {
  try {
    const backend = await controller.backendCookie()
    const url = new URL((req.url ?? '').slice('/runtimes/course'.length), backend.origin)
    if (url.origin !== backend.origin) throw new Error('Invalid protected stream route')
    const upstream = request(url, { headers: headers(req, backend.cookie, new URL(backend.origin).host, true) })
    upstream.on('upgrade', (response, peer, initial) => {
      let responseHead = `HTTP/1.1 ${response.statusCode ?? 101} Switching Protocols\r\n`
      for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && key !== 'set-cookie') responseHead += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`
      socket.write(`${responseHead}\r\n`)
      if (initial.length) socket.write(initial)
      if (head.length) peer.write(head)
      peer.on('error', () => { socket.destroy() })
      socket.on('error', () => { peer.destroy() })
      peer.on('close', () => { socket.destroy() })
      socket.on('close', () => { peer.destroy() })
      peer.on('end', () => { socket.destroy() })
      socket.on('end', () => { peer.destroy() })
      socket.pipe(peer).pipe(socket)
    })
    upstream.on('response', (response) => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n') })
    upstream.on('error', () => { socket.destroy() })
    socket.on('close', () => { upstream.destroy() })
    upstream.end()
  } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\n\r\n') }
}
