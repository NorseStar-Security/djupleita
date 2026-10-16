/** Independent OTLP trace decoder for private loopback receiver fixtures. */
import protobuf from 'protobufjs'

const protocol = protobuf.parse(`syntax = "proto3";
message Value { string stringValue = 1; int64 intValue = 3; }
message Attribute { string key = 1; Value value = 2; }
message Status { string message = 2; int32 code = 3; }
message Link { bytes traceId = 1; bytes spanId = 2; }
message Span { bytes traceId = 1; bytes spanId = 2; bytes parentSpanId = 4; string name = 5;
  int32 kind = 6; fixed64 startTimeUnixNano = 7; fixed64 endTimeUnixNano = 8;
  repeated Attribute attributes = 9; repeated Link links = 13; Status status = 15; }
message Scope { repeated Span spans = 2; }
message Resource { repeated Scope scopeSpans = 2; }
message Request { repeated Resource resourceSpans = 1; }
message Partial { int64 rejectedSpans = 1; string errorMessage = 2; }
message Response { Partial partialSuccess = 1; }`).root

interface WireSpan {
  traceId: number[]
  spanId: number[]
  parentSpanId?: number[]
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano: string
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[]
  links?: { traceId: number[]; spanId: number[] }[]
  status: { code: number }
}

/** Decode actual wire IDs and attributes independently of the production serializer. */
export function decodeSpans(bytes: Uint8Array) {
  const type = protocol.lookupType('Request')
  const request = type.toObject(type.decode(bytes), { bytes: Array, longs: String }) as {
    resourceSpans?: { scopeSpans: { spans: WireSpan[] }[] }[]
  }
  return (request.resourceSpans ?? []).flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans.map(span => ({
    ...span, traceId: Buffer.from(span.traceId).toString('hex'), spanId: Buffer.from(span.spanId).toString('hex'),
    parentSpanId: span.parentSpanId === undefined ? undefined : Buffer.from(span.parentSpanId).toString('hex'),
    attributes: Object.fromEntries(span.attributes.map(value => [value.key, value.value.stringValue ?? value.value.intValue ?? ''])),
  }))))
}

/** Return a wire-level OTLP trace rejection acknowledgement. */
export function tracePartialResponse(rejectedSpans: number): Uint8Array {
  return protocol.lookupType('Response').encode({ partialSuccess: { rejectedSpans } }).finish()
}
