/** Parse untrusted complete HTTP payloads without accepting caller-supplied identity. */
import type { IncomingMessage } from 'node:http'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CollectorQuery, InstallationId, StudentId, CohortId, TrajectoryArtifactId, TrajectoryRecord } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import type { Config } from './index.ts'

/** Sanitized HTTP rejection; uploaded values and credential errors never become its message. */
export class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string, message: string, options?: ErrorOptions) { super(message, options) }
}

/**
 * Read a complete bounded body, releasing listeners on EOF, abort, or rejection.
 * @param req - owned incoming request.
 * @param maxBytes - complete byte limit.
 * @param signal - request cancellation and deadline.
 * @returns complete bytes; a rejected prefix is never returned.
 */
export function body(req: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') throw new HttpFailure(415, 'COLLECTOR_ENCODING', 'Compressed request bodies are not accepted.')
  const declared = req.headers['content-length']
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpFailure(413, 'COLLECTOR_QUOTA', 'The complete request exceeds its byte budget.')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const clean = () => {
      req.off('data', data); req.off('end', end); req.off('error', error); req.off('aborted', abort)
      signal.removeEventListener('abort', abort)
    }
    const fail = (cause: Error) => { clean(); req.pause(); reject(cause) }
    const data = (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) fail(new HttpFailure(413, 'COLLECTOR_QUOTA', 'The complete request exceeds its byte budget.'))
      else chunks.push(chunk)
    }
    const end = () => { clean(); resolve(Buffer.concat(chunks, size)) }
    const error = () => { fail(new HttpFailure(400, 'COLLECTOR_BODY', 'The request body did not complete.')) }
    const abort = () => { fail(new HttpFailure(408, 'COLLECTOR_CANCELLED', 'The request did not complete; a started write may still commit.')) }
    req.on('data', data); req.once('end', end); req.once('error', error); req.once('aborted', abort)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/**
 * Parse the exact record fields; identity is exclusively authorization-provider output.
 * @param bytes - bounded JSON request.
 * @returns one complete original record.
 */
export function record(bytes: Uint8Array): TrajectoryRecord {
  let value: unknown
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch (cause) { throw new HttpFailure(400, 'COLLECTOR_INPUT', 'A complete UTF-8 JSON record is required.', { cause }) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'A record object is required.')
  const row = value as Record<string, unknown>
  const fields = ['sessionId', 'sequence', 'type', 'timestamp', 'content']
  if (Object.keys(row).length !== fields.length || Object.keys(row).some(key => !fields.includes(key))) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Only record fields are accepted; identity is server-derived.')
  if (typeof row.sessionId !== 'string' || !identifier(row.sessionId) || typeof row.type !== 'string' || !identifier(row.type)
    || typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < -1
    || typeof row.timestamp !== 'number' || !Number.isFinite(row.timestamp) || row.timestamp < 0 || typeof row.content !== 'string') {
    throw new HttpFailure(400, 'COLLECTOR_INPUT', 'The record fields are invalid.')
  }
  return { sessionId: SessionId(row.sessionId), sequence: row.sequence, type: row.type, timestamp: row.timestamp, content: row.content }
}

function identifier(value: string): boolean { return value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value) }

function parameter(url: URL, key: string): string | undefined {
  const values = url.searchParams.getAll(key)
  if (values.length > 1 || (values[0] !== undefined && !identifier(values[0]))) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Query parameters must be single bounded values.')
  return values[0]
}

/**
 * Parse exact cursor filters and bounded query budgets.
 * @param url - request URL.
 * @param config - deployment page bounds.
 * @returns validated storage query.
 */
export function query(url: URL, config: Config): CollectorQuery {
  const allowed = ['after', 'limit', 'maxBytes', 'installationId', 'studentId', 'cohortId', 'sessionId']
  if ([...url.searchParams.keys()].some(key => !allowed.includes(key))) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Unknown query parameter.')
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = parameter(url, key)
    if (value === undefined) return fallback
    const parsed = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'The cursor or page budget is invalid.')
    return parsed
  }
  const result: CollectorQuery = { after: number('after', 0, 0, Number.MAX_SAFE_INTEGER), limit: number('limit', config.maxPageRecords, 1, config.maxPageRecords), maxBytes: number('maxBytes', config.maxQueryBytes, 1, config.maxQueryBytes) }
  const installation = parameter(url, 'installationId'); const student = parameter(url, 'studentId'); const cohort = parameter(url, 'cohortId'); const session = parameter(url, 'sessionId')
  if (installation !== undefined) result.installationId = installation as InstallationId
  if (student !== undefined) result.studentId = student as StudentId
  if (cohort !== undefined) result.cohortId = cohort as CohortId
  if (session !== undefined) result.sessionId = SessionId(session)
  return result
}

/**
 * Parse the two exact artifact download selectors.
 * @param url - authenticated request URL.
 * @returns installation and artifact identities.
 */
export function artifactSelector(url: URL): { installation: InstallationId; id: TrajectoryArtifactId } {
  if ([...url.searchParams.keys()].some(key => !['installationId', 'id'].includes(key))) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Unknown artifact selector.')
  const installation = parameter(url, 'installationId'); const id = parameter(url, 'id')
  if (installation === undefined || id === undefined) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'An installation and artifact identity are required.')
  return { installation: installation as InstallationId, id: id as TrajectoryArtifactId }
}

/**
 * Parse binary metadata, without accepting an upload-supplied installation or student.
 * @param req - incoming binary request.
 * @returns validated digest and display filename.
 */
export function artifactHeaders(req: IncomingMessage): { sha256: string; name: string } {
  const sha256 = req.headers['x-trajectory-sha256']; const encoded = req.headers['x-trajectory-name']
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof encoded !== 'string') throw new HttpFailure(400, 'COLLECTOR_INPUT', 'A lowercase SHA-256 digest and encoded filename are required.')
  let name: string
  try { name = decodeURIComponent(encoded) } catch (cause) { throw new HttpFailure(400, 'COLLECTOR_INPUT', 'The artifact filename encoding is invalid.', { cause }) }
  if (!identifier(name) || /[\/\\]/.test(name) || name === '.' || name === '..') throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Use a bounded artifact display filename without directory separators.')
  if (Object.keys(req.headers).some(key => key.startsWith('x-trajectory-') && !['x-trajectory-sha256', 'x-trajectory-name'].includes(key))) throw new HttpFailure(400, 'COLLECTOR_INPUT', 'Upload identity is server-derived.')
  return { sha256, name }
}
