/** Lossless trajectory records carried by standard OTLP protobuf logs. */
import { createHash } from 'node:crypto'
import { SeverityNumber } from '@opentelemetry/api-logs'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { LoggerProvider, type ReadableLogRecord } from '@opentelemetry/sdk-logs'
import { ProtobufLogsSerializer } from '@opentelemetry/otlp-transformer'
import type { CollectorIdentity, TrajectoryRecordId } from '@deepseek-ai/dsh-experimental-trajectory-collector/types'
import { DeliveryError } from './transport.ts'

/** SHA-256 of the exact UTF-8 record bytes, for identity and reassembly checks.
 * @param value - Serialized record.
 * @returns Lowercase hexadecimal digest.
 */
export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Export metadata, separate from student-supplied event content. */
export interface RecordIdentity {
  sourceId: string
  sessionId: string
  sequence: number
  type: string
  timestamp: number
  /** Server-trusted collector identity; never populated from uploaded event attributes. */
  course?: CollectorIdentity
  /** Stable durable intake receipt, disambiguating sessions from different installations. */
  collectorRecordId?: TrajectoryRecordId
}

/** Uses an isolated SDK logger; never installs a global OTel provider. */
export class TrajectoryEncoder {
  private records: ReadableLogRecord[] = []
  private readonly provider = new LoggerProvider({
    resource: resourceFromAttributes({ 'service.name': 'dsh-course-trajectories' }),
    logRecordLimits: { attributeCountLimit: 32, attributeValueLengthLimit: Infinity },
    processors: [{ onEmit: (record) => { this.records.push(record) }, async forceFlush() {}, async shutdown() {} }],
  })
  private readonly logger = this.provider.getLogger('dsh.trajectory', '1');

  /** Encode one complete record or lossless base64 fragments, one bounded request per part.
   * @param value - Complete JSON header or canonical event, without truncation.
   * @param identity - Instructor-assigned source and persisted event identity.
   * @param fragmentBytes - Maximum raw bytes in a fragment.
   * @param maxRequestBytes - Maximum encoded HTTP request bytes.
   * @returns Ordered protobuf requests; acknowledge every part before checkpointing.
   */
  *encode(value: string, identity: RecordIdentity, fragmentBytes: number, maxRequestBytes: number): Generator<Uint8Array> {
    const bytes = Buffer.from(value)
    const parts = Math.max(1, Math.ceil(bytes.length / fragmentBytes))
    const contentHash = digest(value)
    const recordId = identity.collectorRecordId
      ?? digest(JSON.stringify([identity.sourceId, identity.sessionId, identity.sequence, contentHash]))
    for (let part = 0; part < parts; part++) {
      this.records = []
      this.logger.emit({
        eventName: parts === 1 ? 'dsh.trajectory.record' : 'dsh.trajectory.fragment',
        timestamp: identity.timestamp,
        severityNumber: SeverityNumber.INFO,
        body: parts === 1 ? value : bytes.subarray(part * fragmentBytes, (part + 1) * fragmentBytes).toString('base64'),
        attributes: {
          'dsh.trajectory.schema': 1,
          'dsh.source.id': identity.sourceId,
          'dsh.session.id': identity.sessionId,
          'dsh.event.seq': identity.sequence,
          'dsh.event.type': identity.type,
          'dsh.record.id': recordId,
          'dsh.record.sha256': contentHash,
          'dsh.record.encoding': parts === 1 ? 'json' : 'base64-json-utf8',
          'dsh.record.part': part,
          'dsh.record.parts': parts,
          ...identity.course === undefined ? {} : {
            'dsh.course.installation.id': identity.course.installationId,
            'dsh.course.student.id': identity.course.studentId,
            'dsh.course.cohort.id': identity.course.cohortId,
          },
        },
      })
      const request = ProtobufLogsSerializer.serializeRequest(this.records)
      if (request === undefined || request.byteLength > maxRequestBytes) throw new DeliveryError('TRAJECTORY_REQUEST_TOO_LARGE', false)
      yield request
    }
  }

  /** Release the isolated SDK logger.
   * @returns Completion of SDK shutdown.
   */
  async close(): Promise<void> { await this.provider.forceFlush(); await this.provider.shutdown() }
}
