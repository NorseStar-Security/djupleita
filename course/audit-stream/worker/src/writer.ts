/**
 * Who a `POST /v1/logs` request writes as. A seat token names its seat. A course token names
 * only a cohort and a seat-id prefix, so the seat id comes from the records' `dsh.source.id`
 * (the exporter `sourceId`), and the seat id doubles as the student label: one seat per student.
 */
import type { SeatIdentity } from './ledger.ts'
import type { OtlpLogRecord } from './otlp.ts'
import { isLabel, type TokenClaims } from './token.ts'

/** A writer the token does not allow; `status` is the HTTP answer. */
export class WriterRejected extends Error {
  override readonly name = 'WriterRejected'
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

/**
 * Resolve the trusted seat identity for one upload.
 * @param claims - Verified token claims.
 * @param records - The request's decoded records; at least one.
 * @returns The identity the seat ledger binds and checks every record against.
 */
export function writerIdentity(claims: TokenClaims, records: readonly OtlpLogRecord[]): SeatIdentity {
  if (claims.kind === 'seat') return { cohort: claims.cohort, student: claims.student, installation: claims.installation }
  if (claims.kind !== 'course') throw new WriterRejected(403, 'SEAT_TOKEN_REQUIRED', 'only seat or course tokens may upload')
  const source = records[0]?.attributes['dsh.source.id']
  if (typeof source !== 'string' || !isLabel(source)) throw new WriterRejected(400, 'BAD_SOURCE', 'dsh.source.id must be a label')
  if (!source.startsWith(claims.installation) || source.length === claims.installation.length) {
    throw new WriterRejected(403, 'SOURCE_OUTSIDE_COURSE', `seat ids written with this course token must start with ${claims.installation}`)
  }
  // The seat ledger refuses any later record whose dsh.source.id differs from this one.
  return { cohort: claims.cohort, student: source, installation: source }
}
