/**
 * HMAC-SHA-256 tokens for the audit stream: `nsa1.<base64url claims>.<base64url signature>`.
 *
 * A seat token authenticates one course installation as a writer and as a reader of its own
 * records. A board token reads one cohort, or every cohort when its cohort is `*`. An admin
 * token revokes seats. Identity always comes from verified claims, never from uploaded data.
 */

/** Token roles. */
export type TokenKind = 'seat' | 'board' | 'admin'

/** Verified token claims. */
export interface TokenClaims {
  kind: TokenKind
  /** Cohort label; `*` only on board tokens. */
  cohort: string
  /** Student label; seat tokens only. */
  student: string
  /** Installation label, equal to the seat exporter's `sourceId`; seat tokens only. */
  installation: string
  /** Expiry as Unix seconds. */
  expiresAt: number
  /** Random nonce that makes two tokens with equal claims distinct. */
  nonce: string
}

/** A missing, malformed, forged, or expired token. */
export class TokenError extends Error {
  override readonly name = 'TokenError'
}

/** Prefix of every token this module signs. */
export const TOKEN_PREFIX = 'nsa1'

const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

/**
 * Check a cohort, student, or installation label used in storage keys.
 * @param value - Candidate label.
 * @returns Whether the label is 1 to 64 characters of `[A-Za-z0-9._-]` starting alphanumeric.
 */
export function isLabel(value: string): boolean {
  return LABEL.test(value)
}

function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new TokenError('token segment is not base64url')
  const padded = text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new TokenError('token key must be at least 32 characters')
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

function checkClaims(claims: TokenClaims): TokenClaims {
  if (!['seat', 'board', 'admin'].includes(claims.kind)) throw new TokenError('unknown token kind')
  if (!Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= 0) throw new TokenError('token expiry is invalid')
  if (typeof claims.nonce !== 'string' || claims.nonce.length < 8) throw new TokenError('token nonce is invalid')
  if (claims.kind === 'seat') {
    if (!isLabel(claims.cohort) || !isLabel(claims.student) || !isLabel(claims.installation)) throw new TokenError('seat token labels are invalid')
  } else if (claims.kind === 'board') {
    if (claims.cohort !== '*' && !isLabel(claims.cohort)) throw new TokenError('board token cohort is invalid')
    if (claims.student !== '' || claims.installation !== '') throw new TokenError('board tokens carry no seat labels')
  } else if (claims.cohort !== '' || claims.student !== '' || claims.installation !== '') {
    throw new TokenError('admin tokens carry no labels')
  }
  return claims
}

/**
 * Sign claims into a token.
 * @param secret - Shared HMAC key, at least 32 characters.
 * @param claims - Claims to sign; validated before signing.
 * @returns The token string.
 */
export async function signToken(secret: string, claims: TokenClaims): Promise<string> {
  const checked = checkClaims(claims)
  const payload = base64url(encoder.encode(JSON.stringify({
    k: checked.kind, c: checked.cohort, s: checked.student, i: checked.installation, x: checked.expiresAt, n: checked.nonce,
  })))
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(`${TOKEN_PREFIX}.${payload}`))
  return `${TOKEN_PREFIX}.${payload}.${base64url(new Uint8Array(signature))}`
}

/**
 * Verify a token's signature, structure, and expiry.
 * @param secret - Shared HMAC key.
 * @param token - Token string, without a `Bearer ` prefix.
 * @param nowSeconds - Current Unix time in seconds.
 * @returns The verified claims.
 */
export async function verifyToken(secret: string, token: string, nowSeconds: number): Promise<TokenClaims> {
  const segments = token.split('.')
  if (segments.length !== 3 || segments[0] !== TOKEN_PREFIX) throw new TokenError('token format is invalid')
  const [prefix, payload, signature] = segments as [string, string, string]
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64url(signature), encoder.encode(`${prefix}.${payload}`))
  if (!valid) throw new TokenError('token signature is invalid')
  let raw: unknown
  try {
    raw = JSON.parse(decoder.decode(fromBase64url(payload)))
  } catch (error) {
    throw new TokenError(`token claims are unreadable: ${String(error)}`)
  }
  if (typeof raw !== 'object' || raw === null) throw new TokenError('token claims are not an object')
  const fields = raw as Record<string, unknown>
  const claims = checkClaims({
    kind: fields['k'] as TokenKind,
    cohort: typeof fields['c'] === 'string' ? fields['c'] : '',
    student: typeof fields['s'] === 'string' ? fields['s'] : '',
    installation: typeof fields['i'] === 'string' ? fields['i'] : '',
    expiresAt: typeof fields['x'] === 'number' ? fields['x'] : 0,
    nonce: typeof fields['n'] === 'string' ? fields['n'] : '',
  })
  if (claims.expiresAt <= nowSeconds) throw new TokenError('token has expired')
  return claims
}

/**
 * Read a Bearer token from an Authorization header.
 * @param header - Header value, or `null` when absent.
 * @returns The token, or `undefined` when the header is absent or not a Bearer credential.
 */
export function bearer(header: string | null): string | undefined {
  const match = header === null ? null : /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1]
}
