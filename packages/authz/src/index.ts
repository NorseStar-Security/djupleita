/** Isolated A/B/anonymous replays with evidence-backed authorization candidates. */
import { z } from 'zod';
import { digest, PentestError } from '@dsh-pentest/contracts';
import type { Evidence, IdentityId, Json, SessionId } from '@dsh-pentest/contracts';
import type { HttpBroker, HttpInput, HttpResult } from '@dsh-pentest/http';
import type { IdentityService } from '@dsh-pentest/identities';
import type { TrajectoryStore } from '@dsh-pentest/trajectory';
import { graphId } from '@dsh-pentest/graph';
import type { AttackGraph } from '@dsh-pentest/graph';

export interface ComparisonInput {
  request: HttpInput; identityA: IdentityId; identityB: IdentityId; anonymous: boolean;
}
export interface ReplaySummary { identity: string; status: number; bodyHash: string; size: number; evidence: Evidence }
export interface Comparison {
  id: string; verdict: 'candidate' | 'no-signal' | 'verified'; reason: string;
  replays: ReplaySummary[]; assertionId?: string;
}
/** Only an operator-installed assertion can promote matching responses to verified. */
export interface OwnershipAssertion {
  id: string; description: string;
  verify(input: ComparisonInput, results: ReadonlyMap<string, HttpResult>): boolean;
}
export class AuthzService {
  private readonly assertions = new Map<string, OwnershipAssertion>();
  constructor(private readonly http: HttpBroker, private readonly identities: IdentityService,
    private readonly graph: AttackGraph, private readonly trajectory: TrajectoryStore) {}

  registerAssertion(assertion: OwnershipAssertion): () => void {
    if (!assertion.id || this.assertions.has(assertion.id)) throw new PentestError('AUTHZ_ASSERTION', 'Assertion identifier is empty or already registered');
    this.assertions.set(assertion.id, assertion);
    return () => { this.assertions.delete(assertion.id); };
  }

  async compare(input: ComparisonInput, sessionId: SessionId, signal: AbortSignal, assertionId?: string): Promise<Comparison> {
    if (input.identityA === input.identityB) throw new PentestError('AUTHZ_IDENTITIES', 'A/B comparison requires two distinct identities');
    this.identities.get(input.identityA); this.identities.get(input.identityB);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(input.request.method)) {
      throw new PentestError('AUTHZ_MUTATION', 'Automatic A/B replay requires a read method; mutation tests need an explicit scenario with reset/cleanup');
    }
    const assertion = assertionId ? this.assertions.get(assertionId) : undefined;
    if (assertionId && !assertion) throw new PentestError('AUTHZ_ASSERTION', 'Unknown operator-installed ownership assertion');
    const results = new Map<string, HttpResult>();
    const replayIds = [input.identityA, input.identityB, ...(input.anonymous ? ['anonymous'] : [])];
    for (const identity of replayIds) {
      const { identityId: _ignored, ...request } = input.request;
      results.set(identity, await this.http.request({ ...request,
        ...(identity !== 'anonymous' ? { identityId: identity as IdentityId } : {}) }, sessionId, signal, undefined, 'active'));
    }
    const replays = [...results].map(([identity, response]) => ({ identity, status: response.status,
      bodyHash: digest(response.body), size: Buffer.byteLength(response.body), evidence: response.evidence }));
    const a = replays[0]!, b = replays[1]!;
    const sameSuccess = a.status >= 200 && a.status < 300 && b.status >= 200 && b.status < 300 && a.bodyHash === b.bodyHash;
    const verified = assertion ? assertion.verify(input, results) : false;
    const comparison: Comparison = { id: digest({ sessionId, evidence: replays.map(item => item.evidence.id) }),
      verdict: verified ? 'verified' : sameSuccess ? 'candidate' : 'no-signal',
      reason: verified ? `Operator assertion passed: ${assertion!.description}` : sameSuccess
        ? 'Both identities received the same successful response. Ownership and sensitivity need verification.'
        : 'Responses differ or access was denied; this comparison alone does not establish an authorization issue.',
      replays, ...(assertion ? { assertionId: assertion.id } : {}) };
    await this.trajectory.append(sessionId, 'authz/comparison', z.json().parse(comparison) as Json);
    this.record(input, comparison);
    return comparison;
  }

  private record(input: ComparisonInput, comparison: Comparison): void {
    const endpoint = graphId(this.graph.engagementId, 'object', input.request.url);
    const evidenceIds = comparison.replays.map(replay => replay.evidence.id);
    const observedAt = comparison.replays[0]!.evidence.observedAt;
    for (const replay of comparison.replays) this.graph.addEvidence(replay.evidence);
    this.graph.putNode({ id: endpoint, type: 'Resource', name: input.request.url, evidenceIds,
      attributes: { url: input.request.url }, observedAt });
    for (const replay of comparison.replays) {
      const actor = graphId(this.graph.engagementId, 'identity', replay.identity);
      const identity = replay.identity === 'anonymous' ? undefined : this.identities.get(replay.identity as IdentityId);
      this.graph.putNode({ id: actor, type: 'Identity', name: identity?.name ?? 'Anonymous',
        evidenceIds: [replay.evidence.id], attributes: identity ? { role: identity.role, tenant: identity.tenant, identityId: identity.id } : {}, observedAt });
      this.graph.putEdge({ id: digest({ actor, endpoint, comparison: comparison.id }), source: actor, target: endpoint,
        type: 'CanRead', status: comparison.verdict === 'verified' && replay.status >= 200 && replay.status < 300 ? 'verified' : 'inferred',
        evidenceIds: [replay.evidence.id], attributes: { status: replay.status, comparison: comparison.id,
          walkable: replay.status >= 200 && replay.status < 300, verdict: comparison.verdict }, observedAt });
    }
  }
}
