/** Acknowledgement-aware OTLP HTTP transport without an in-memory export queue. */
import { open } from 'node:fs/promises'
import { ProtobufLogsSerializer, ProtobufTraceSerializer } from '@opentelemetry/otlp-transformer'

/** Safe diagnostics: never include response bodies, credentials, or fetch causes. */
export class DeliveryError extends Error {
  constructor(readonly code: string, readonly retryable: boolean, readonly retryAfterMs = 0) { super(code) }
}

/** Read a file with a byte limit enforced before allocating its complete contents.
 * @param path - Credential or checkpoint file.
 * @param maxBytes - Maximum accepted file bytes.
 * @returns UTF-8 contents.
 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null)
      if (read.bytesRead === 0) return buffer.subarray(0, length).toString('utf8')
      length += read.bytesRead
    }
    throw new DeliveryError('TRAJECTORY_FILE_TOO_LARGE', false)
  } finally { await handle.close() }
}

/** Validate a rotating bearer token without allowing extra headers.
 * @param path - Private instructor-managed token file, never a token in profile config.
 * @returns Trimmed bearer token.
 */
export async function readToken(path: string): Promise<string> {
  const token = (await readBoundedFile(path, 4096)).trim()
  if (!/^[\x21-\x7e]+$/.test(token)) throw new DeliveryError('TRAJECTORY_TOKEN_INVALID', false)
  return token
}

/** Budgets and credentials for one destination. */
export interface TransportConfig {
  endpoint: string
  tokenFile: string
  timeoutMs: number
  maxResponseBytes: number
}

/** Deliver one protobuf request; only a complete successful OTLP response acknowledges it.
 * @param config - Explicit destination and complete-response budgets.
 * @param payload - Already bounded serialized request.
 * @param lifetime - Plugin lifetime cancellation.
 * @param signalKind - OTLP response message matching the emitted telemetry signal; defaults to logs.
 * @returns Completion only after an unqualified successful acknowledgement.
 */
export async function deliver(
  config: TransportConfig, payload: Uint8Array, lifetime: AbortSignal, signalKind: 'logs' | 'traces' = 'logs',
): Promise<void> {
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(config.timeoutMs)])
  const token = await readToken(config.tokenFile)
  let response: Response
  try {
    response = await fetch(config.endpoint, { method: 'POST', redirect: 'manual', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-protobuf' }, body: Buffer.from(payload) })
    const chunks: Uint8Array[] = []
    let length = 0
    if (response.body !== null) {
      const reader = response.body.getReader()
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          length += chunk.value.byteLength
          if (length > config.maxResponseBytes) throw new DeliveryError('TRAJECTORY_RESPONSE_TOO_LARGE', false)
          chunks.push(chunk.value)
        }
      } finally { await reader.cancel(); reader.releaseLock() }
    }
    if (response.status !== 200) {
      const retry = response.headers.get('retry-after')
      const retryAfterMs = retry === null ? 0 : /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now())
      throw new DeliveryError(`TRAJECTORY_HTTP_${response.status}`, [429, 502, 503, 504].includes(response.status),
        Number.isFinite(retryAfterMs) ? retryAfterMs : 0)
    }
    if (length > 0 && response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/x-protobuf') {
      throw new DeliveryError('TRAJECTORY_RESPONSE_ENCODING', false)
    }
    let rejected: number
    try {
      const responseBytes = Buffer.concat(chunks)
      rejected = signalKind === 'logs'
        ? ProtobufLogsSerializer.deserializeResponse(responseBytes).partialSuccess?.rejectedLogRecords ?? 0
        : ProtobufTraceSerializer.deserializeResponse(responseBytes).partialSuccess?.rejectedSpans ?? 0
    }
    catch (error) {
      // An invalid acknowledgement cannot authorize cursor advancement.
      void error
      throw new DeliveryError('TRAJECTORY_RESPONSE_INVALID', false)
    }
    if (rejected !== 0) throw new DeliveryError('TRAJECTORY_PARTIAL_REJECTION', false)
  } catch (error) {
    if (error instanceof DeliveryError) throw error
    lifetime.throwIfAborted()
    throw new DeliveryError('TRAJECTORY_TRANSPORT_UNAVAILABLE', true)
  }
}
