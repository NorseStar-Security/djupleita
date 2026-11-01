import { id } from '../packages/contracts/src/index.ts';
import type { Action, Engagement, Scope, SessionId, TrajectoryEvent, TrajectorySink, Json, JudgmentProvider } from '../packages/contracts/src/index.ts';
import type { PolicyConfig } from '../packages/policy/src/index.ts';

export function scope(host = '*.example.test', port = 443): Scope {
  return { targets: [{ host, schemes: ['https'], ports: [port], pathPrefixes: ['/'], allowPrivateAddresses: false }],
    exclusions: [], networks: [], services: { intelligence: [], model: [], telemetry: [] } };
}
export function engagement(overrides: Partial<Engagement> = {}): Engagement {
  return { id: id<'EngagementId'>(), name: 'Local acceptance lab', objectives: ['Verify authorization between two users'],
    scope: scope(), model: { provider: 'test', model: 'test' },
    budget: { requests: 100, concurrency: 4, durationMs: 60_000, requestsPerSecond: 1e9, maxDepth: 4, maxResponseBytes: 1024 * 1024 }, ...overrides };
}
export function action(overrides: Partial<Action> = {}): Action {
  return { id: id<'ActionId'>(), engagementId: id<'EngagementId'>(), sessionId: id<'SessionId'>(), tool: 'http_request', plugin: 'http',
    arguments: { url: 'https://app.example.test/' }, destinations: [{ url: 'https://app.example.test/', purpose: 'target' }],
    effects: ['read'], reversible: true, ...overrides };
}
export const policyConfig: PolicyConfig = { minimumConfidence: 0.8, deletionThreshold: 0.5, disruptionThreshold: 0.7, judgmentTimeoutMs: 1000, rules: [] };
export const testJudge: JudgmentProvider = { name: 'test-judge', async judge() {
  return { deletion: 0, irreversible: 0, disruption: 0, confidence: 0.99, reason: 'Bounded lab operation' };
} };
export class MemorySink implements TrajectorySink {
  readonly events: TrajectoryEvent[] = [];
  async append(sessionId: SessionId, type: string, data: Json): Promise<TrajectoryEvent> {
    const event = { seq: this.events.length, timestamp: new Date().toISOString(), engagementId: id<'EngagementId'>(),
      sessionId, type, data, previousHash: '', hash: '' };
    this.events.push(event);
    return event;
  }
}
