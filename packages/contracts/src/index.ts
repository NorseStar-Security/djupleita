/** Shared engagement, effect, decision, and evidence values. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type EngagementId = Brand<string, 'EngagementId'>;
export type IdentityId = Brand<string, 'IdentityId'>;
export type ActionId = Brand<string, 'ActionId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type SessionId = Brand<string, 'SessionId'>;

/** Mint an opaque identifier without accepting a model-provided value. */
export function id<Name extends string>(): Brand<string, Name> {
  return randomUUID() as Brand<string, Name>;
}

/** Deterministic JSON used for effect bindings and evidence hashes. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new TypeError('Expected a finite, JSON-serializable value');
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

/** Freeze a detached JSON tree before exposing engagement-owned state. */
export function freeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const PurposeSchema = z.enum(['target', 'intelligence', 'model', 'telemetry']);
export type Purpose = z.infer<typeof PurposeSchema>;
export const DestinationSchema = z.object({ url: z.url(), purpose: PurposeSchema });
export type Destination = z.infer<typeof DestinationSchema>;

export const HostRuleSchema = z.object({
  host: z.string().min(1),
  schemes: z.array(z.enum(['http', 'https', 'tcp', 'tls'])).min(1),
  ports: z.array(z.number().int().min(1).max(65535)).min(1),
  pathPrefixes: z.array(z.string().startsWith('/')).default(['/']),
  allowPrivateAddresses: z.boolean().default(false),
});
export type HostRule = z.infer<typeof HostRuleSchema>;
export const ScopeSchema = z.object({
  targets: z.array(HostRuleSchema),
  exclusions: z.array(z.string()).default([]),
  networks: z.array(z.string()).default([]),
  services: z.object({
    intelligence: z.array(HostRuleSchema).default([]),
    model: z.array(HostRuleSchema).default([]),
    telemetry: z.array(HostRuleSchema).default([]),
  }),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const BudgetSchema = z.object({
  requests: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  concurrency: z.number().int().positive(),
  requestsPerSecond: z.number().positive(),
  maxDepth: z.number().int().nonnegative(),
  maxResponseBytes: z.number().int().positive(),
});
export type Budget = z.infer<typeof BudgetSchema>;
export const ModelSelectionSchema = z.object({ provider: z.string().min(1), model: z.string().min(1) });
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;
export const EngagementSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  objectives: z.array(z.string()).min(1),
  scope: ScopeSchema,
  budget: BudgetSchema,
  model: ModelSelectionSchema,
});
export type Engagement = Omit<z.infer<typeof EngagementSchema>, 'id'> & { id: EngagementId };

export const EffectSchema = z.enum(['read', 'create', 'modify', 'delete', 'overwrite', 'disrupt', 'unknown']);
export type Effect = z.infer<typeof EffectSchema>;
export const ActionSchema = z.object({
  id: z.string().uuid(),
  engagementId: z.string().uuid(),
  sessionId: z.string().min(1),
  tool: z.string().min(1),
  plugin: z.string().min(1),
  arguments: z.json(),
  destinations: z.array(DestinationSchema),
  effects: z.array(EffectSchema).min(1),
  reversible: z.boolean(),
  identityId: z.string().uuid().optional(),
  parentId: z.string().optional(),
});
export type Action = Omit<z.infer<typeof ActionSchema>, 'id' | 'engagementId' | 'sessionId' | 'identityId'> & {
  id: ActionId;
  engagementId: EngagementId;
  sessionId: SessionId;
  identityId?: IdentityId;
};
export type DecisionKind = 'allow' | 'warn' | 'ask' | 'deny';
export interface Decision {
  kind: DecisionKind;
  reasons: string[];
  source: string;
  policyVersion: string;
  actionHash: string;
  confidence?: number;
}
export interface Judgment {
  deletion: number;
  irreversible: number;
  disruption: number;
  confidence: number;
  reason: string;
}
export interface JudgmentProvider {
  readonly name: string;
  judge(action: Readonly<Action>, model: Readonly<ModelSelection>, signal: AbortSignal): Promise<Judgment>;
}
export interface TrajectoryEvent {
  seq: number;
  timestamp: string;
  engagementId: EngagementId;
  sessionId: SessionId;
  type: string;
  data: Json;
  previousHash: string;
  hash: string;
}
export interface TrajectorySink {
  append(sessionId: SessionId, type: string, data: Json): Promise<TrajectoryEvent>;
}
export interface Evidence {
  id: EvidenceId;
  contentHash: string;
  pointer: string;
  mediaType: string;
  tool: string;
  observedAt: string;
  identityId?: IdentityId;
}

export class PentestError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PentestError';
  }
}
