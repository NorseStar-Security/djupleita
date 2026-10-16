import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { IncomingMessage, request } from 'node:http'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import CredentialsLocal from '@deepseek-ai/dsh-credentials-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import SqliteCollector from '@deepseek-ai/dsh-experimental-trajectory-collector-sqlite'
import { CollectorError, TrajectoryUploadAuth } from '@deepseek-ai/dsh-experimental-trajectory-collector'
import type { CollectorIdentity, CollectorPage, CollectorReceipt, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import * as Http from '../src/index.ts'
import { body, query, record } from '../src/parsing.ts'

const identity: CollectorIdentity = { installationId: 'installation-one' as CollectorIdentity['installationId'], studentId: 'student-one' as CollectorIdentity['studentId'], cohortId: 'cohort-one' as CollectorIdentity['cohortId'] }
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) { try { await cleanup() } catch (error) { failures.push(error) } }
  if (failures.length) throw new AggregateError(failures, 'collector HTTP fixture cleanup failed')
})

function barrier() {
  let release = () => {}
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

class AuthFixture extends TrajectoryUploadAuth {
  failure: Error | undefined
  hold = false
  entered = barrier()
  readonly cancelled = barrier()
  override async authenticate(authorization: string | undefined, signal: AbortSignal): Promise<CollectorIdentity> {
    this.entered.release()
    if (this.hold) await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => { this.cancelled.release(); reject(new Error('fixture authorization cancelled', { cause: signal.reason })) }, { once: true })
    })
    if (this.failure !== undefined) throw this.failure
    if (authorization !== 'Bearer fixture-course-token') throw new CollectorError('COLLECTOR_AUTH', 'fixture secret must never be returned')
    return identity
  }
}

function header(): TrajectoryRecord {
  return { sessionId: SessionId('course-session'), sequence: -1, type: 'session/header', timestamp: 1000, content: JSON.stringify({ header: { id: 'course-session', createdAt: 1000 }, inheritedEventCount: 0 }) }
}
function event(text = 'complete event'): TrajectoryRecord {
  return { sessionId: SessionId('course-session'), sequence: 0, type: 'tool/result', timestamp: 1001, content: JSON.stringify({ seq: 0, type: 'tool/result', time: 1001, text }) }
}

async function composition(config: Partial<Http.Config> = {}, options = { uploadAuth: true, instructorAuth: true }) {
  const root = await mkdtemp(join(tmpdir(), 'collector-http-test-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, web: WebServer, collector: SqliteCollector, auth: AuthFixture,
    credentials: CredentialsLocal, connection: Connection, http: Http,
  })
  const file = join(root, 'cordis.yml')
  await writeFile(file, JSON.stringify([
    { name: 'cordis:web', config: { host: '127.0.0.1', port: 0 } },
    { name: 'cordis:collector', config: { path: join(root, 'archive', 'collector.sqlite') } },
    ...options.uploadAuth ? [{ name: 'cordis:auth' }] : [],
    ...options.instructorAuth ? [{ name: 'cordis:credentials', config: { path: join(root, 'credentials.yaml'), dshHome: root, watch: false } }, { name: 'cordis:connection' }] : [],
    { id: 'collector-http', name: 'cordis:http', config },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const unloaded = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  expect(unloaded.map(entry => entry.options.name)).toEqual([])
  const origin = ctx.webServer.getOrigin()
  let cookie = ''
  if (options.instructorAuth) {
    const target = new URL(ctx.connection.authenticatedUrl(origin))
    if (config.serveRoot) {
      const login = await fetch(target, { redirect: 'manual' })
      expect(login.status).toBe(303)
      cookie = login.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
    } else ctx.connection.authorizeIndex({ method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } }, {
      writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';', 1)[0] ?? '' }, end() {},
    })
    expect(cookie).not.toBe('')
  }
  const post = (value: object, extra: Record<string, string> = {}) => fetch(`${origin}/api/trajectory/records`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) })
  const get = (path: string) => fetch(`${origin}${path}`, { headers: { cookie } })
  return { ctx, origin, post, get, cookie, auth: ctx.get('trajectoryUploadAuth') as AuthFixture | undefined }
}

describe('collector HTTP through real Loader, SQLite storage, and Host Connection authentication', () => {
  it('keeps the function plugin exports and independent route defaults', () => {
    expect(Object.keys(Http).sort()).toEqual(['Config', 'apply', 'inject', 'name'])
    expect(Http.Config()).toMatchObject({ path: '/api/trajectory', dashboardPath: '/trajectory' })
    expect(() => Http.Config({ path: '/bad/' })).toThrow()
    expect(() => { Http.apply(new Context(), Object.assign(Http.Config(), { dashboardPath: '/api/trajectory/records' })) }).toThrow('distinct')
  })
  it('rejects absent authorizers, missing/invalid credentials, and caller-supplied identity', async () => {
    const missing = await composition({}, { uploadAuth: false, instructorAuth: false })
    expect((await missing.post(header())).status).toBe(503)
    expect((await missing.get('/api/trajectory/records')).status).toBe(503)
    const { ctx, post, origin } = await composition()
    const denied = await post(header(), { authorization: 'Bearer stolen-or-expired' })
    expect(denied.status).toBe(401)
    expect(await denied.text()).not.toContain('fixture secret')
    expect((await fetch(`${origin}/api/trajectory/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(header()) })).status).toBe(401)
    expect((await post({ ...header(), identity: { studentId: 'someone-else' } })).status).toBe(400)
    expect((await ctx.trajectoryCollector.status()).records).toBe(0)
  })
  it('ACKs only committed complete records and preserves trusted identity across replay and conflicts', async () => {
    const { ctx, post, get } = await composition()
    const receipt = await (await post(header())).json() as CollectorReceipt
    expect(receipt.duplicate).toBe(false)
    expect((await (await post(header())).json() as CollectorReceipt).duplicate).toBe(true)
    expect((await post({ ...header(), content: JSON.stringify({ header: { id: 'course-session', createdAt: 1000 }, inheritedEventCount: 1 }) })).status).toBe(409)
    const text = '<script>alert("unsafe & untrusted")</script>'
    expect((await post(event(text))).status).toBe(200)
    const page = await (await get('/api/trajectory/records?installationId=installation-one&after=1&limit=1')).json() as CollectorPage
    expect(page.records).toHaveLength(1)
    expect(page.records[0]?.identity).toEqual(identity)
    expect(page.records[0]?.content).toBe(event(text).content)
    expect((await ctx.trajectoryCollector.status()).records).toBe(2)
    const html = await get('/trajectory')
    expect(html.headers.get('cache-control')).toBe('no-store')
    expect(html.headers.get('content-security-policy')).toContain("default-src 'none'")
    const rendered = await html.text()
    expect(rendered).not.toContain('<script>')
    expect(rendered).toContain('&lt;script&gt;')
    expect(rendered).toContain('&amp;')
  })
  it('uses real Host authentication and Host/Origin trust on every inspection route', async () => {
    const { origin, cookie } = await composition()
    for (const path of ['/trajectory', '/api/trajectory/records', '/api/trajectory/status', '/api/trajectory/artifacts']) {
      expect((await fetch(`${origin}${path}`)).status).toBe(401)
      expect((await fetch(`${origin}${path}`, { headers: { cookie, origin: 'https://untrusted.test' } })).status).toBe(403)
    }
    expect((await fetch(`${origin}/api/trajectory/status`, { headers: { cookie } })).status).toBe(200)
    expect((await fetch(`${origin}/api/trajectory/status`, { method: 'POST', headers: { cookie } })).status).toBe(405)
  })
  it('exchanges the existing launch token through an opt-in root, then redirects the authenticated instructor', async () => {
    const { origin, cookie, ctx, get } = await composition({ serveRoot: true })
    expect((await fetch(origin, { redirect: 'manual' })).status).toBe(401)
    const authenticated = await fetch(origin, { headers: { cookie }, redirect: 'manual' })
    expect(authenticated.status).toBe(303)
    expect(authenticated.headers.get('location')).toBe('/trajectory')
    expect(authenticated.headers.get('cache-control')).toBe('no-store')
    expect((await get('/trajectory')).status).toBe(200)
    const login = ctx.connection.authenticatedUrl(origin)
    const untrusted = await fetch(login, { headers: { origin: 'https://untrusted.test' }, redirect: 'manual' })
    expect(untrusted.status).toBe(403)
    expect(untrusted.headers.get('set-cookie')).toBeNull()
    expect((await fetch(origin, { method: 'POST', headers: { cookie }, redirect: 'manual' })).status).toBe(405)
    const missing = await composition({ serveRoot: true }, { uploadAuth: false, instructorAuth: false })
    expect((await fetch(missing.origin)).status).toBe(503)
  })
  it('does not own the root route unless the dedicated collector enables it', async () => {
    const { origin } = await composition()
    expect((await fetch(origin)).status).toBe(404)
  })
  it('rolls back partial route registration when another plugin already owns a requested path', async () => {
    const { ctx, get } = await composition()
    const remove = ctx.webServer.register({ kind: 'exact', path: '/collision/records', handler(_req, res) { res.end('other owner') } })
    cleanups.push(async () => { remove() })
    expect(() => { Http.apply(ctx, Http.Config({ path: '/collision', dashboardPath: '/collision-dashboard' })) }).toThrow('duplicate')
    expect((await get('/collision-dashboard')).status).toBe(404)
    expect(await (await get('/collision/records')).text()).toBe('other owner')
  })
  it('keeps the dedicated root after the existing Connection provider reloads', async () => {
    const { ctx, origin } = await composition({ serveRoot: true })
    const entry = [...ctx.loader.entries()].find(value => value.options.name === 'cordis:connection')
    if (entry === undefined) throw new Error('Connection fixture missing')
    await ctx.loader.update(entry.id, { config: { cookieMaxAgeDays: 29 } })
    await ctx.loader.await()
    const login = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
    expect(login.status).toBe(303)
  })
  it('stores binary attachments with trusted identity and downloads them only as non-rendered attachments', async () => {
    const { origin, get, ctx } = await composition()
    const data = Buffer.from('<svg onload="alert(1)">complete binary</svg>')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const send = (extra: Record<string, string> = {}) => fetch(`${origin}/api/trajectory/artifacts`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/octet-stream', 'x-trajectory-sha256': sha256, 'x-trajectory-name': encodeURIComponent('untrusted "image"!(1)*.svg'), ...extra }, body: data })
    expect((await send({ 'x-trajectory-installation': 'someone-else' })).status).toBe(400)
    expect((await send({ 'x-trajectory-sha256': '0'.repeat(64) })).status).toBe(400)
    const uploaded = await (await send()).json() as { id: string }
    const downloaded = await get(`/api/trajectory/artifacts?installationId=installation-one&id=${uploaded.id}`)
    expect(downloaded.status).toBe(200)
    expect(downloaded.headers.get('content-type')).toBe('application/octet-stream')
    expect(downloaded.headers.get('content-disposition')).toContain('attachment;')
    expect(downloaded.headers.get('content-disposition')).toContain('%22image%22%21%281%29%2A.svg')
    expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(data)
    expect((await get(`/api/trajectory/artifacts?installationId=someone-else&id=${uploaded.id}`)).status).toBe(404)
    await ctx.trajectoryCollector.revoke(identity.installationId)
    expect((await send()).status).toBe(403)
    expect((await get(`/api/trajectory/artifacts?installationId=installation-one&id=${uploaded.id}`)).status).toBe(200)
  })
  it('rejects byte limits, content encodings, malformed JSON, query widening, and incomplete binary metadata', async () => {
    const { origin, post, get, ctx, cookie } = await composition({ maxRecordBytes: 256, maxArtifactBytes: 8 })
    expect((await post({ ...header(), content: 'x'.repeat(300) })).status).toBe(413)
    expect((await post(header(), { 'content-encoding': 'gzip' })).status).toBe(415)
    expect((await post(header(), { 'content-type': 'text/plain' })).status).toBe(415)
    for (const suffix of ['?limit=101', '?after=-1', '?limit=1&limit=2', '?unexpected=value', '?maxBytes=1048577']) expect((await get(`/api/trajectory/records${suffix}`)).status).toBe(400)
    expect((await get('/api/trajectory/status?anything=1')).status).toBe(400)
    expect((await get('/api/trajectory/artifacts')).status).toBe(400)
    expect((await get('/api/trajectory/artifacts?installationId=x&id=y&extra=z')).status).toBe(400)
    expect((await fetch(`${origin}/api/trajectory/records?extra=x`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token' } })).status).toBe(400)
    expect((await fetch(`${origin}/api/trajectory/artifacts?extra=x`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token' } })).status).toBe(400)
    expect((await fetch(`${origin}/api/trajectory/artifacts`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'text/plain' } })).status).toBe(415)
    for (const path of ['/trajectory', '/api/trajectory/records']) {
      expect((await fetch(`${origin}${path}`, { method: 'DELETE', headers: { cookie } })).status).toBe(405)
    }
    for (const name of ['%', encodeURIComponent('../file'), '.', '..', encodeURIComponent('control\u0000')]) {
      expect((await fetch(`${origin}/api/trajectory/artifacts`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/octet-stream', 'x-trajectory-sha256': '0'.repeat(64), 'x-trajectory-name': name }, body: 'x' })).status).toBe(400)
    }
    const malformed = await fetch(`${origin}/api/trajectory/records`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/json' }, body: '{' })
    expect(malformed.status).toBe(400)
    const binary = await fetch(`${origin}/api/trajectory/artifacts`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/octet-stream' }, body: 'x' })
    expect(binary.status).toBe(400)
    expect((await ctx.trajectoryCollector.status()).records).toBe(0)
  })
  it('counts received chunked bytes, not only a declared content length', async () => {
    const { origin } = await composition({ maxRecordBytes: 20 })
    const result = await new Promise<number>((resolve, reject) => {
      const req = request(`${origin}/api/trajectory/records`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/json' } }, (res) => { res.resume(); res.once('end', () => { resolve(Number(res.statusCode)) }) })
      req.once('error', reject)
      req.write('a'.repeat(10)); req.end('b'.repeat(11))
    })
    expect(result).toBe(413)
  })
  it('rejects an entire response or binary object when its complete byte budget is exceeded', async () => {
    const { ctx, origin, post, get } = await composition({ maxResponseBytes: 1024, maxArtifactBytes: 8 })
    expect((await post(header())).status).toBe(200)
    expect((await post(event('<'.repeat(1100)))).status).toBe(200)
    expect((await get('/api/trajectory/records')).status).toBe(413)
    expect((await get('/trajectory')).status).toBe(413)
    const data = Buffer.from('123456789')
    const sha256 = createHash('sha256').update(data).digest('hex')
    expect((await fetch(`${origin}/api/trajectory/artifacts`, { method: 'POST', headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/octet-stream', 'x-trajectory-sha256': sha256, 'x-trajectory-name': 'artifact.bin' }, body: data })).status).toBe(413)
    const id = await ctx.trajectoryCollector.putArtifact(identity, { data, sha256, name: 'artifact.bin' })
    expect((await get(`/api/trajectory/artifacts?installationId=installation-one&id=${id}`)).status).toBe(413)
  })
  it('retains storage through timeout and unload, never ACKing a write before durable settlement', async () => {
    const { ctx, post, get } = await composition({ timeoutMs: 1000, maxConcurrent: 1 })
    const entered = barrier(); const release = barrier()
    cleanups.push(async () => { release.release() })
    const append = ctx.trajectoryCollector.append.bind(ctx.trajectoryCollector)
    vi.spyOn(ctx.trajectoryCollector, 'append').mockImplementation(async (...args) => { entered.release(); await release.promise; return append(...args) })
    const pending = post(header())
    await entered.promise
    expect((await get('/api/trajectory/status')).status).toBe(503)
    const response = await pending
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('started write may still commit')
    expect((await ctx.trajectoryCollector.status()).records).toBe(0)
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'collector-http')
    if (entry?.fiber === undefined) throw new Error('HTTP fixture was not loaded')
    let disposed = false
    const unloading = entry.fiber.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.release()
    await unloading
    expect((await ctx.trajectoryCollector.status()).records).toBe(1)
    expect((await get('/api/trajectory/status')).status).toBe(404)
  })
  it('propagates client cancellation into upload authorization and sanitizes dependency errors', async () => {
    const { auth, origin, post } = await composition()
    if (auth === undefined) throw new Error('upload auth fixture missing')
    auth.failure = new Error('Bearer secret token and uploaded text must never escape')
    const failed = await post(header())
    expect(failed.status).toBe(503)
    expect(await failed.text()).not.toContain('secret token')
    auth.failure = undefined
    auth.hold = true
    auth.entered = barrier()
    const controller = new AbortController()
    const pending = fetch(`${origin}/api/trajectory/records`, { method: 'POST', signal: controller.signal, headers: { authorization: 'Bearer fixture-course-token', 'content-type': 'application/json' }, body: JSON.stringify(header()) })
    await auth.entered.promise
    controller.abort()
    await expect(pending).rejects.toThrow()
    await auth.cancelled.promise
  })
})

describe('collector wire parser', () => {
  it.each([null, [], {}, { ...header(), sequence: 0.5 }, { ...header(), sequence: -2 }, { ...header(), timestamp: -1 }, { ...header(), sessionId: '' }, { ...header(), type: '\u0000' }, { ...header(), content: 1 }])('rejects incomplete or invalid record %j', (value) => {
    expect(() => record(Buffer.from(JSON.stringify(value)))).toThrow()
  })
  it('rejects invalid UTF-8 and bounded query identifiers', () => {
    expect(() => record(Uint8Array.from([0xff]))).toThrow('UTF-8')
    expect(() => query(new URL('http://x/?installationId='), Http.Config())).toThrow()
    expect(() => query(new URL('http://x/?studentId=a&studentId=b'), Http.Config())).toThrow()
    expect(query(new URL('http://x/?studentId=s&cohortId=c&sessionId=x'), Http.Config())).toMatchObject({ studentId: 's', cohortId: 'c', sessionId: 'x' })
  })
  it('owns body error and cancellation listeners without returning a partial prefix', async () => {
    for (const terminal of ['error', 'aborted', 'signal'] as const) {
      const socket = new Socket()
      const req = new IncomingMessage(socket)
      const controller = new AbortController()
      const pending = body(req, 100, controller.signal)
      req.emit('data', Buffer.from('partial'))
      if (terminal === 'signal') controller.abort()
      else if (terminal === 'error') req.emit('error', new Error('wire text must not escape'))
      else req.emit('aborted')
      await expect(pending).rejects.toThrow(terminal === 'error' ? 'body did not complete' : 'request did not complete')
      for (const name of ['data', 'end', 'error', 'aborted']) expect(req.listenerCount(name)).toBe(0)
      socket.destroy()
    }
  })
})
