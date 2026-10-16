/** Validated commands and immutable journal records; external evidence is always untrusted data. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { DomainTableSpec } from '@deepseek-ai/dsh-storage-domain'

/** Stable business-local asset identity. */
export type AssetId = Branded<'AssessmentAssetId'>
/** Immutable evidence or observation record identity. */
export type RecordId = Branded<'AssessmentRecordId'>
/** Operator-configured assessment identity. */
export type AssessmentId = Branded<'AssessmentId'>
const text = z.string().min(1).max(4096)
const id = z.string().min(1).max(160)
const assetId = id.transform(value => brandString<AssetId>(value))
const recordId = id.transform(value => brandString<RecordId>(value))
const attributes = z.record(z.string().min(1).max(128), z.union([z.string().max(4096), z.number(), z.boolean()]))

/** Evidence references retain hashes and locations rather than duplicating raw secrets. */
export const evidenceSchema = z.object({
  source: text, locator: text, contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  summary: text, observedAt: z.iso.datetime(),
}).strict()
/** Canonical observation input; service observations require a port. */
export const observationSchema = z.object({
  kind: z.enum(['domain', 'ip', 'url', 'service', 'identity', 'resource', 'business-service']),
  value: text, port: z.number().int().min(1).max(65535).optional(),
  attributes: attributes.default({}), confidence: z.number().min(0).max(1),
  basis: z.enum(['observed', 'inferred']),
  identity: z.object({ provider: z.string().regex(/^[a-z][a-z0-9-]*$/).max(128), realm: text,
    nativeType: text, nativeId: text }).strict().optional(),
}).strict().refine(value => value.kind !== 'service' || value.port !== undefined, 'service requires port')
/** Preconditions under which an attempt can be compared with another attempt. */
export const contextSchema = z.object({ environment: text, principal: text, vantage: text }).strict()
/** Operator-controlled metadata; stored once and immutable for each assessment id. */
export const assessmentSchema = z.object({
  id: id.transform(value => brandString<AssessmentId>(value)), businessId: id, businessName: text,
  objectives: z.array(text).min(1).max(100), scopePolicyHash: text,
  validFrom: z.iso.datetime(), validUntil: z.iso.datetime(),
}).strict().refine(value => Date.parse(value.validUntil) > Date.parse(value.validFrom), 'validUntil must follow validFrom')

/** Model submissions cannot create or widen assessment permissions. */
export const commandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('capture'), observations: z.array(observationSchema).min(1).max(10000),
    evidence: evidenceSchema, coverage: z.enum(['best-effort', 'partial', 'complete']),
    relationships: z.array(z.object({ sourceIndex: z.number().int().nonnegative(),
      targetIndex: z.number().int().nonnegative(), relation: z.string().regex(/^x-assessment:[A-Za-z][A-Za-z0-9]*$/),
      originalType: text.optional() }).strict()).max(10000).default([]) }).strict(),
  z.object({ kind: z.literal('relate'), source: assetId, target: assetId, relation: z.string().regex(/^x-assessment:[A-Za-z][A-Za-z0-9]*$/),
    state: z.enum(['observed', 'inferred', 'validated', 'blocked']), confidence: z.number().min(0).max(1),
    evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('retract'), observationId: recordId, reason: text, evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('task'), id, title: text, reason: text, assetIds: z.array(assetId).max(100),
    prerequisites: z.array(id).max(100), priority: z.enum(['low', 'medium', 'high', 'critical']),
    retryWhen: text, stopWhen: text, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('claim'), taskId: id, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('task-settle'), taskId: id, expectedRevision: z.number().int().positive(),
    status: z.enum(['done', 'blocked', 'pending']), reason: text }).strict(),
  z.object({ kind: z.literal('attempt'), id, assetIds: z.array(assetId).min(1).max(100), method: text,
    toolVersion: text, context: contextSchema, outcome: z.enum(['completed', 'inconclusive', 'blocked', 'failed-to-execute',
      'not-attempted']),
    conclusion: z.enum(['confirmed', 'not-reproduced', 'inconclusive']), evidence: evidenceSchema,
    applicableUntil: z.iso.datetime(), configurationFingerprint: text }).strict(),
  z.object({ kind: z.literal('finding'), id, expectedRevision: z.number().int().nonnegative(), assetIds: z.array(assetId).min(1).max(100),
    title: text, businessImpact: text, owner: text, severity: z.enum(['low', 'medium', 'high', 'critical']),
    status: z.enum(['open', 'remediation-reported', 'fix-verified', 'reopened']), verificationAttemptId: id.optional(),
    evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('artifact'), id, expectedRevision: z.number().int().nonnegative(), assetIds: z.array(assetId).min(1).max(100),
    description: text, owner: text, expiresAt: z.iso.datetime(), vaultRef: text.optional(),
    status: z.enum(['present', 'cleanup-reported', 'cleanup-verified']), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('hypothesis'), id, expectedRevision: z.number().int().nonnegative(),
    assetIds: z.array(assetId).min(1).max(100), relationIds: z.array(recordId).max(100),
    question: text, businessImpact: text, prerequisites: z.array(text).max(100),
    status: z.enum(['possible', 'validated', 'rejected']), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('detection'), attemptId: id,
    telemetry: z.enum(['observed', 'absent', 'unknown']), alert: z.enum(['observed', 'absent', 'unknown']),
    response: z.enum(['observed', 'absent', 'unknown']), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('handoff'), summary: text, nextActions: z.array(text).max(100), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('objective'), id, expectedRevision: z.number().int().nonnegative(),
    businessServiceId: assetId, assetIds: z.array(assetId).min(1).max(100), title: text, owner: text,
    businessImpact: text, successCriteria: z.array(text).min(1).max(100), evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('capability'), id, expectedRevision: z.number().int().nonnegative(),
    source: assetId, target: assetId, action: text, context: contextSchema,
    validationMethod: text, configurationFingerprint: text,
    state: z.enum(['available', 'blocked', 'unknown']),
    conditions: z.array(z.object({ id, description: text, satisfied: z.boolean().nullable() }).strict()).max(100),
    requires: z.array(id).max(100), supportObservationIds: z.array(recordId).min(1).max(100),
    validFrom: z.iso.datetime(), validUntil: z.iso.datetime(), verificationAttemptId: id.optional(),
    evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('path'), id, expectedRevision: z.number().int().nonnegative(),
    entry: assetId, target: assetId, capabilityIds: z.array(id).min(1).max(100), objectiveId: id,
    evidence: evidenceSchema }).strict(),
  z.object({ kind: z.literal('coverage-plan'), id, expectedRevision: z.number().int().nonnegative(),
    assetIds: z.array(assetId).min(1).max(100), objectiveId: id, method: text,
    context: contextSchema, configurationFingerprint: text, evidence: evidenceSchema }).strict(),
])
/** Fully validated model submission. */
export type AssessmentCommand = z.infer<typeof commandSchema>
/** Evidence reference accepted by capture adapters. */
export type Evidence = z.infer<typeof evidenceSchema>
/** Fully validated asset observation. */
export type Observation = z.infer<typeof observationSchema>
/** Trusted assessment configuration. */
export type Assessment = z.infer<typeof assessmentSchema>
/** Attempt context supplied by the operator or explicitly bound session. */
export type AttemptContext = z.infer<typeof contextSchema>

const binding = z.object({ kind: z.literal('bind'), context: contextSchema, assessment: assessmentSchema }).strict()
const dispatch = z.object({ kind: z.literal('dispatch'), callId: id, tool: text,
  argumentsHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const result = z.object({ kind: z.literal('result'), callId: id, tool: text,
  outcome: z.enum(['completed', 'failed-to-execute']), evidence: evidenceSchema,
  observations: z.array(observationSchema).max(10000),
  relationships: z.array(z.object({ source: observationSchema, target: observationSchema,
    relation: z.string().regex(/^x-assessment:[A-Za-z][A-Za-z0-9]*$/) }).strict()).max(10000),
  coverage: z.enum(['best-effort', 'unparsed', 'failed']), policyHash: text.optional(),
}).strict()
/** One atomic journal entry contains both the accepted operation and its replay inputs. */
export const eventSchema = z.object({
  id: recordId, claimLeaseMs: z.number().int().positive(), sequence: z.number().int().nonnegative(), time: z.iso.datetime(),
  assessmentId: id.transform(value => brandString<AssessmentId>(value)), sessionId: id,
  operationKey: id, payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.union([binding, dispatch, result, commandSchema]),
}).strict()
/** Validated immutable journal transaction. */
export type MemoryEvent = z.infer<typeof eventSchema>
/** Storage domain declaration; each business gets its own operator-selected domain.
 * @param name - storage domain matching the backend naming grammar.
 * @returns versioned immutable journal declaration.
 */
export function memoryDomain(name: string): {
  name: string
  version: number
  tables: { events: DomainTableSpec<string, MemoryEvent> }
} {
  return defineDomain({ name, version: 1, tables: { events: domainTable(eventSchema) } })
}
