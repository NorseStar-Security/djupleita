/**
 * The audit-stream receiver: authenticated OTLP/HTTP logs intake for course seats, read-only
 * seat and cohort inspection, and the live board.
 *
 * `POST /v1/logs` acknowledges only after the seat ledger has stored every part durably. Storage
 * and Durable Object failures answer 503 with `Retry-After`, which the exporter retries.
 */
import { boardHtml } from './board.ts'
import type { Env } from './env.ts'
import { decodeLogsJson, decodeLogsProtobuf, OtlpDecodeError } from './otlp.ts'
import { INSTALLATION_HEADER, ROLE_HEADER } from './room.ts'
import { bearer, isLabel, TokenError, verifyToken, type TokenClaims } from './token.ts'

export { CohortRoom } from './room.ts'
export { SeatLedger } from './seat.ts'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

class HttpError extends Error {
  override readonly name = 'HttpError'
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...JSON_HEADERS, ...headers } })
}

async function claimsFrom(token: string | undefined, env: Env): Promise<TokenClaims> {
  if (token === undefined || token === '') throw new TokenError('missing token')
  return verifyToken(env.AUDIT_TOKEN_KEY, token, Math.floor(Date.now() / 1000))
}

function seatStub(env: Env, installation: string) {
  if (!isLabel(installation)) throw new HttpError(400, 'BAD_INSTALLATION', 'installation must be a label')
  return env.SEAT.get(env.SEAT.idFromName(installation))
}

async function ingest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') throw new HttpError(405, 'METHOD', 'use POST')
  const claims = await claimsFrom(bearer(request.headers.get('authorization')), env)
  if (claims.kind !== 'seat') throw new HttpError(403, 'SEAT_TOKEN_REQUIRED', 'only seat tokens may upload')
  const mediaType = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (mediaType !== 'application/x-protobuf' && mediaType !== 'application/json') throw new HttpError(415, 'MEDIA_TYPE', 'send application/x-protobuf or application/json')
  if (request.headers.get('content-encoding') !== null) throw new HttpError(415, 'ENCODING', 'compressed request bodies are not accepted')
  const limit = Number(env.MAX_REQUEST_BYTES)
  if (Number(request.headers.get('content-length') ?? '0') > limit) throw new HttpError(413, 'TOO_LARGE', `requests are limited to ${limit} bytes`)
  const body = new Uint8Array(await request.arrayBuffer())
  if (body.length > limit) throw new HttpError(413, 'TOO_LARGE', `requests are limited to ${limit} bytes`)
  let text = ''
  if (mediaType === 'application/json') {
    try {
      text = utf8.decode(body)
    } catch (error) {
      throw new OtlpDecodeError(`request is not UTF-8: ${String(error)}`)
    }
  }
  const records = mediaType === 'application/json' ? decodeLogsJson(text) : decodeLogsProtobuf(body)
  if (records.length > 0) {
    const identity = { cohort: claims.cohort, student: claims.student, installation: claims.installation }
    const outcome = await seatStub(env, identity.installation).commit(identity, records)
    if (!outcome.ok) throw new HttpError(outcome.status, outcome.code, outcome.message)
    const { activities } = outcome.result
    if (activities.length > 0) ctx.waitUntil(env.ROOM.get(env.ROOM.idFromName(identity.cohort)).publish(activities))
  }
  return mediaType === 'application/json'
    ? json({})
    : new Response(null, { status: 200, headers: { 'content-type': 'application/x-protobuf' } })
}

function canReadCohort(claims: TokenClaims, cohort: string): boolean {
  return (claims.kind === 'board' && (claims.cohort === '*' || claims.cohort === cohort)) || (claims.kind === 'seat' && claims.cohort === cohort)
}

async function socket(request: Request, env: Env, url: URL): Promise<Response> {
  const cohort = url.searchParams.get('cohort') ?? ''
  if (!isLabel(cohort)) throw new HttpError(400, 'BAD_COHORT', 'cohort must be a label')
  const claims = await claimsFrom(url.searchParams.get('token') ?? undefined, env)
  if (!canReadCohort(claims, cohort)) throw new HttpError(403, 'FORBIDDEN', 'this token cannot watch that cohort')
  const headers = new Headers(request.headers)
  headers.delete(ROLE_HEADER)
  headers.delete(INSTALLATION_HEADER)
  headers.set(ROLE_HEADER, claims.kind === 'seat' ? 'seat' : 'instructor')
  if (claims.kind === 'seat') headers.set(INSTALLATION_HEADER, claims.installation)
  return env.ROOM.get(env.ROOM.idFromName(cohort)).fetch(new Request(request.url, { headers }))
}

async function readableSeat(env: Env, claims: TokenClaims, installation: string) {
  const stub = seatStub(env, installation)
  if (claims.kind === 'seat') {
    if (claims.installation !== installation) throw new HttpError(403, 'FORBIDDEN', 'seat tokens read only their own seat')
    return stub
  }
  if (claims.kind !== 'board') throw new HttpError(403, 'FORBIDDEN', 'board or seat token required')
  const summary = await stub.summary()
  if (summary.identity === undefined) throw new HttpError(404, 'UNKNOWN_SEAT', 'no records for that installation')
  if (claims.cohort !== '*' && claims.cohort !== summary.identity.cohort) throw new HttpError(403, 'FORBIDDEN', 'this token cannot read that seat')
  return stub
}

function integer(value: string | null, fallback: number): number {
  if (value === null || value === '') return fallback
  if (!/^-?\d+$/.test(value)) throw new HttpError(400, 'BAD_INTEGER', 'expected an integer')
  return Number(value)
}

async function api(request: Request, env: Env, url: URL): Promise<Response> {
  const claims = await claimsFrom(bearer(request.headers.get('authorization')), env)
  const installation = url.searchParams.get('installation') ?? ''
  const session = url.searchParams.get('session') ?? ''
  switch (`${request.method} ${url.pathname}`) {
    case 'GET /api/cohort': {
      const cohort = url.searchParams.get('cohort') ?? ''
      if (!isLabel(cohort) || claims.kind !== 'board' || !canReadCohort(claims, cohort)) throw new HttpError(403, 'FORBIDDEN', 'board token for that cohort required')
      return json(await env.ROOM.get(env.ROOM.idFromName(cohort)).snapshot())
    }
    case 'GET /api/seat':
      return json(await (await readableSeat(env, claims, installation)).summary())
    case 'GET /api/records':
      return json(await (await readableSeat(env, claims, installation)).records(session, integer(url.searchParams.get('after'), -2), integer(url.searchParams.get('limit'), 200)))
    case 'GET /api/raw': {
      const bytes = await (await readableSeat(env, claims, installation)).raw(session, integer(url.searchParams.get('seq'), -1))
      if (bytes === null) throw new HttpError(404, 'UNKNOWN_RECORD', 'no complete record at that sequence')
      return new Response(bytes, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
    }
    case 'POST /api/revoke': {
      if (claims.kind !== 'admin') throw new HttpError(403, 'FORBIDDEN', 'admin token required')
      const revoked = await seatStub(env, installation).revoke(url.searchParams.get('reason') ?? 'revoked by operator')
      return json({ revoked })
    }
    default:
      throw new HttpError(404, 'NOT_FOUND', 'unknown API route')
  }
}

function board(): Response {
  const nonce = crypto.randomUUID().replaceAll('-', '')
  return new Response(boardHtml(nonce), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  })
}

export default {
  /**
   * Route one request.
   * @param request - Incoming request.
   * @param env - Bindings.
   * @param ctx - Execution context for background fan-out.
   * @returns The response.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    try {
      if (url.pathname === '/v1/logs') return await ingest(request, env, ctx)
      if (url.pathname === '/health') return json({ ok: true, service: 'ns-audit' })
      if (url.pathname === '/board' && request.method === 'GET') return board()
      if (url.pathname === '/ws') return await socket(request, env, url)
      if (url.pathname.startsWith('/api/')) return await api(request, env, url)
      throw new HttpError(404, 'NOT_FOUND', 'unknown route')
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status)
      if (error instanceof TokenError) return json({ error: 'UNAUTHORIZED', message: error.message }, 401)
      if (error instanceof OtlpDecodeError) return json({ error: 'BAD_OTLP', message: error.message }, 400)
      console.error('ns-audit request failed', url.pathname, String(error))
      return json({ error: 'UNAVAILABLE', message: 'storage is unavailable; retry later' }, 503, { 'retry-after': '5' })
    }
  },
} satisfies ExportedHandler<Env>
