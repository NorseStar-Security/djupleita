/**
 * Decoders for the OTLP/HTTP logs requests that `dsh-experimental-trajectory-export-otlp` sends.
 *
 * Only the `ExportLogsServiceRequest` fields that carry log records, their bodies, and their
 * attributes are interpreted; every other field is skipped by wire type. Protobuf groups are
 * rejected because OTLP never uses them.
 */

/** A scalar OTLP attribute value; array, key-value-list, and bytes values decode to `null`. */
export type AttributeValue = string | number | boolean | null

/** One decoded OTLP log record. */
export interface OtlpLogRecord {
  /** `time_unix_nano` as a decimal string, or `undefined` when the field is absent or zero. */
  timeUnixNano: string | undefined
  /** `event_name`, or the empty string when absent. */
  eventName: string
  /** The string body, or `undefined` when the body is absent or not a string. */
  body: string | undefined
  /** Record attributes; a repeated key keeps its last value. */
  attributes: Record<string, AttributeValue>
}

/** A request that is not valid OTLP logs input. */
export class OtlpDecodeError extends Error {
  override readonly name = 'OtlpDecodeError'
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false })

class Reader {
  readonly buf: Uint8Array
  pos: number
  readonly end: number

  constructor(buf: Uint8Array, start: number, end: number) {
    this.buf = buf
    this.pos = start
    this.end = end
  }

  done(): boolean {
    return this.pos >= this.end
  }

  varint(): bigint {
    let result = 0n
    let shift = 0n
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new OtlpDecodeError('truncated varint')
      const byte = this.buf[this.pos++]!
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
    }
    throw new OtlpDecodeError('varint longer than 10 bytes')
  }

  tag(): { field: number, wire: number } {
    const value = this.varint()
    if (value > 0xffffffffn) throw new OtlpDecodeError('field tag out of range')
    return { field: Number(value >> 3n), wire: Number(value & 7n) }
  }

  private take(length: number): number {
    if (length < 0 || this.pos + length > this.end) throw new OtlpDecodeError('field extends past its message')
    const start = this.pos
    this.pos += length
    return start
  }

  delimited(): Reader {
    const length = this.varint()
    if (length > BigInt(this.end - this.pos)) throw new OtlpDecodeError('field extends past its message')
    const start = this.take(Number(length))
    return new Reader(this.buf, start, this.pos)
  }

  string(): string {
    const inner = this.delimited()
    try {
      return utf8.decode(inner.buf.subarray(inner.pos, inner.end))
    } catch (error) {
      throw new OtlpDecodeError(`string is not UTF-8: ${String(error)}`)
    }
  }

  fixed64(): bigint {
    const start = this.take(8)
    return new DataView(this.buf.buffer, this.buf.byteOffset + start, 8).getBigUint64(0, true)
  }

  double(): number {
    const start = this.take(8)
    return new DataView(this.buf.buffer, this.buf.byteOffset + start, 8).getFloat64(0, true)
  }

  skip(wire: number): void {
    switch (wire) {
      case 0: this.varint(); return
      case 1: this.take(8); return
      case 2: this.delimited(); return
      case 5: this.take(4); return
      default: throw new OtlpDecodeError(`unsupported wire type ${wire}`)
    }
  }
}

function expectWire(actual: number, expected: number, field: string): void {
  if (actual !== expected) throw new OtlpDecodeError(`${field} has wire type ${actual}, expected ${expected}`)
}

function int64(value: bigint): number {
  const signed = BigInt.asIntN(64, value)
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new OtlpDecodeError('integer attribute exceeds the safe integer range')
  }
  return Number(signed)
}

function anyValue(reader: Reader): AttributeValue {
  let value: AttributeValue = null
  while (!reader.done()) {
    const { field, wire } = reader.tag()
    switch (field) {
      case 1: expectWire(wire, 2, 'AnyValue.string_value'); value = reader.string(); break
      case 2: expectWire(wire, 0, 'AnyValue.bool_value'); value = reader.varint() !== 0n; break
      case 3: expectWire(wire, 0, 'AnyValue.int_value'); value = int64(reader.varint()); break
      case 4: expectWire(wire, 1, 'AnyValue.double_value'); value = reader.double(); break
      default: reader.skip(wire); value = null
    }
  }
  return value
}

function keyValue(reader: Reader): { key: string, value: AttributeValue } {
  let key = ''
  let value: AttributeValue = null
  while (!reader.done()) {
    const { field, wire } = reader.tag()
    if (field === 1) { expectWire(wire, 2, 'KeyValue.key'); key = reader.string() } else if (field === 2) {
      expectWire(wire, 2, 'KeyValue.value')
      value = anyValue(reader.delimited())
    } else reader.skip(wire)
  }
  return { key, value }
}

function logRecord(reader: Reader): OtlpLogRecord {
  const record: OtlpLogRecord = { timeUnixNano: undefined, eventName: '', body: undefined, attributes: {} }
  while (!reader.done()) {
    const { field, wire } = reader.tag()
    switch (field) {
      case 1: {
        expectWire(wire, 1, 'LogRecord.time_unix_nano')
        const nanos = reader.fixed64()
        record.timeUnixNano = nanos === 0n ? undefined : nanos.toString()
        break
      }
      case 5: {
        expectWire(wire, 2, 'LogRecord.body')
        const body = anyValue(reader.delimited())
        record.body = typeof body === 'string' ? body : undefined
        break
      }
      case 6: {
        expectWire(wire, 2, 'LogRecord.attributes')
        const { key, value } = keyValue(reader.delimited())
        record.attributes[key] = value
        break
      }
      case 12: expectWire(wire, 2, 'LogRecord.event_name'); record.eventName = reader.string(); break
      default: reader.skip(wire)
    }
  }
  return record
}

function repeated(reader: Reader, field: number, name: string, visit: (inner: Reader) => void): void {
  while (!reader.done()) {
    const tag = reader.tag()
    if (tag.field === field) {
      expectWire(tag.wire, 2, name)
      visit(reader.delimited())
    } else reader.skip(tag.wire)
  }
}

/**
 * Decode a binary `ExportLogsServiceRequest`.
 * @param bytes - The complete request body.
 * @returns Every log record in request order.
 */
export function decodeLogsProtobuf(bytes: Uint8Array): OtlpLogRecord[] {
  const records: OtlpLogRecord[] = []
  repeated(new Reader(bytes, 0, bytes.length), 1, 'ExportLogsServiceRequest.resource_logs', (resourceLogs) => {
    repeated(resourceLogs, 2, 'ResourceLogs.scope_logs', (scopeLogs) => {
      repeated(scopeLogs, 2, 'ScopeLogs.log_records', (log) => { records.push(logRecord(log)) })
    })
  })
  return records
}

function jsonScalar(value: unknown): AttributeValue {
  if (typeof value !== 'object' || value === null) return null
  const entry = value as Record<string, unknown>
  if (typeof entry['stringValue'] === 'string') return entry['stringValue']
  if (typeof entry['boolValue'] === 'boolean') return entry['boolValue']
  const intValue = entry['intValue']
  if (typeof intValue === 'number' && Number.isSafeInteger(intValue)) return intValue
  if (typeof intValue === 'string' && /^-?\d+$/.test(intValue)) return int64(BigInt.asUintN(64, BigInt(intValue)))
  if (typeof entry['doubleValue'] === 'number') return entry['doubleValue']
  return null
}

function jsonArray(value: unknown, name: string): unknown[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new OtlpDecodeError(`${name} must be an array`)
  return value
}

function jsonObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OtlpDecodeError(`${name} must be an object`)
  return value as Record<string, unknown>
}

/**
 * Decode an OTLP/HTTP JSON `ExportLogsServiceRequest`.
 * @param text - The complete request body.
 * @returns Every log record in request order.
 */
export function decodeLogsJson(text: string): OtlpLogRecord[] {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    throw new OtlpDecodeError(`request is not JSON: ${String(error)}`)
  }
  const records: OtlpLogRecord[] = []
  for (const resourceLogs of jsonArray(jsonObject(root, 'request').resourceLogs, 'resourceLogs')) {
    for (const scopeLogs of jsonArray(jsonObject(resourceLogs, 'resourceLogs[]').scopeLogs, 'scopeLogs')) {
      for (const log of jsonArray(jsonObject(scopeLogs, 'scopeLogs[]').logRecords, 'logRecords')) {
        const entry = jsonObject(log, 'logRecords[]')
        const attributes: Record<string, AttributeValue> = {}
        for (const attribute of jsonArray(entry['attributes'], 'attributes')) {
          const pair = jsonObject(attribute, 'attributes[]')
          if (typeof pair['key'] === 'string') attributes[pair['key']] = jsonScalar(pair['value'])
        }
        const body = jsonScalar(entry['body'])
        const time = entry['timeUnixNano']
        records.push({
          timeUnixNano: (typeof time === 'string' && /^\d+$/.test(time) && time !== '0') ? time : (typeof time === 'number' && time > 0 ? String(time) : undefined),
          eventName: typeof entry['eventName'] === 'string' ? entry['eventName'] : '',
          body: typeof body === 'string' ? body : undefined,
          attributes,
        })
      }
    }
  }
  return records
}
