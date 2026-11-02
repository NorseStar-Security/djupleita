import { expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AssessmentService } from '../packages/assessment/src/index.ts';
import { EngagementService } from '../packages/engagement/src/index.ts';
import { ScopeService } from '../packages/scope/src/index.ts';
import { PolicyService } from '../packages/policy/src/index.ts';
import { HttpBroker, endsSession } from '../packages/http/src/index.ts';
import type { Transport } from '../packages/http/src/index.ts';
import { IdentityService } from '../packages/identities/src/index.ts';
import { EvidenceStore, Redactor, TrajectoryStore } from '../packages/trajectory/src/index.ts';
import { id } from '../packages/contracts/src/index.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';

async function fixture(maxRequests = 30) {
  const root = await mkdtemp(join(tmpdir(), 'djupleita-assessment-')), base = 'https://app.example.test';
  const config = engagement(), session = id<'SessionId'>(), redactor = new Redactor();
  const scope = new ScopeService(config.scope, async () => [{ address: '93.184.216.34', family: 4 }]);
  const values = new Map<string, string>();
  const identities = new IdentityService(config.id, { async get(key) { return values.get(key); }, async set(key, value) { values.set(key, value); }, async remove(key) { values.delete(key); } }, redactor);
  const owner = await identities.create({ name: 'Fixture owner', role: 'member', tenant: 'one', hosts: ['app.example.test'], kind: 'bearer' }, 'fixture-owner-value');
  const other = await identities.create({ name: 'Fixture other', role: 'member', tenant: 'two', hosts: ['app.example.test'], kind: 'bearer' }, 'fixture-other-value');
  const trajectories = new TrajectoryStore(join(root, 'trajectories'), config.id, redactor), evidence = new EvidenceStore(root, redactor);
  const policy = new PolicyService(policyConfig, scope, testJudge, config.model, trajectories, redactor);
  const requests: string[] = [];
  let revision = 'revision-one', clock = 1700000000000;
  let mode: 'vulnerable' | 'denied' | 'login' | 'bad-control' | 'offline' | 'stall' = 'vulnerable';
  const transport: Transport = async (_grant, input, headers, _limit, signal) => {
    requests.push(input.url);
    if (mode === 'stall') { await new Promise<never>((_resolve, reject) => { signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); }
    if (mode === 'offline') throw new Error('Fixture transport unavailable');
    const path = new URL(input.url).pathname;
    const authenticated = headers.authorization === 'Bearer fixture-owner-value';
    if (path === '/ready') return { status: 200, headers: {}, body: authenticated ? 'protected fixture marker' : 'public welcome' };
    if (path === '/objects/0') return { status: 200, headers: {}, body: JSON.stringify({ id: mode === 'bad-control' ? 'owned-object' : 'different-object' }) };
    if (mode === 'denied' && !authenticated) return { status: 403, headers: {}, body: '{}' };
    if (mode === 'login' && !authenticated) return { status: 200, headers: {}, body: '<input type="password">' };
    return { status: 200, headers: {}, body: JSON.stringify({ id: 'owned-object' }) };
  };
  const deps = { revision: () => revision, checkUrl: (url: string) => { scope.check({ url, purpose: 'target' }); },
    hasIdentity: (identity: string) => identities.list().some(item => item.id === identity),
    http: (): HttpBroker => broker(), evidence, redactor, now: () => clock };
  let service: AssessmentService = new AssessmentService(join(root, 'assessment.sqlite'), deps);
  const initial = service.budgetState();
  let budget: EngagementService = new EngagementService(config, () => clock, { ...(initial ? { initial } : {}), save: value => service.saveBudget(value) });
  budget.attach(session);
  const broker = (): HttpBroker => new HttpBroker({ timeoutMs: 5000, maxRedirects: 3, maxRequestBytes: 4096 }, budget, scope, policy,
    identities, trajectories, evidence, redactor, transport, undefined, undefined, service);
  const run = service.create({ title: 'Fixture assessment', maxRequests, validationReserve: 3,
    cells: [{ surface: `${base}/objects/1`, method: 'GET', input: 'object ID', family: 'authorization', identity: other.id }] }, session);
  const readiness = { url: `${base}/ready`, identityId: owner.id, expectedText: 'protected fixture marker', ttlMs: 1000 };
  const assertion = { id: 'object-boundary', title: 'Other identity reads owner object', url: `${base}/objects/1`, ownerIdentityId: owner.id,
    otherIdentityId: other.id, jsonPointer: '/id', expectedValue: 'owned-object', negativeControlUrl: `${base}/objects/0` };
  const configure = (browserRequired = false) => service.configure(run.id, { ...readiness, browserRequired }, [assertion]);
  configure();
  return { root, base, run, session, owner, other, evidence, requests, configure, assertion, readiness,
    get service() { return service; }, get budget() { return budget; }, broker,
    setMode(value: typeof mode) { mode = value; }, advance(ms: number) { clock += ms; }, revise() { revision = 'revision-two'; },
    async ready() { return service.readiness(run.id, session, AbortSignal.timeout(5000)); },
    async validate() { return service.validate(run.id, assertion.id, session, AbortSignal.timeout(5000)); },
    async reopen() {
      service.close(); service = new AssessmentService(join(root, 'assessment.sqlite'), deps);
      const saved = service.budgetState()!; budget = new EngagementService(config, () => clock, { initial: saved, save: value => service.saveBudget(value) }); budget.attach(session);
    },
    async close() { service.close(); await trajectories.flush(); await rm(root, { recursive: true, force: true }); },
  };
}

it('checks a live authenticated baseline, proves authorization with controls and excludes unreviewed findings from reports', async () => {
  const f = await fixture();
  try {
    await expect(f.validate()).rejects.toThrow(/Readiness/);
    await f.ready(); const finding = await f.validate();
    expect(finding).toMatchObject({ status: 'verified', reviewed: 'pending' }); expect(finding.evidenceIds).toHaveLength(3);
    expect((await f.service.report(f.run.id)).json).toMatchObject({ findings: [] });
    f.service.reviewFinding(f.run.id, finding.id, true, 'Object ownership and negative control inspected');
    const report = await f.service.report(f.run.id);
    expect(report.json).toMatchObject({ findings: [{ status: 'verified', reviewed: 'accepted' }], evidence: expect.any(Array) });
    expect(JSON.stringify(report)).not.toContain('fixture-owner-value'); expect(report.markdown).toContain('Model cost: unknown');
    const covered = await f.service.cover(f.run.id, f.run.cells[0]!.id, 'tested', 'Other identity returned owner object', [finding.evidenceIds[1]!]);
    expect(covered.cells[0]!.status).toBe('tested');
    expect(f.service.control(f.run.id, 'complete', 'Declared object cell tested').state).toBe('completed');
    await expect(f.broker().request({ url: `${f.base}/more`, method: 'GET', headers: {} }, f.session, AbortSignal.timeout(5000))).rejects.toThrow();
  } finally { await f.close(); }
});

it('keeps login pages, denied access, generic status matches and infrastructure failures out of verified findings', async () => {
  const f = await fixture(100);
  try {
    for (const [mode, expected] of [['login', 'inconclusive'], ['bad-control', 'inconclusive'], ['denied', 'rejected'], ['offline', 'inconclusive']] as const) {
      f.setMode(mode === 'offline' ? 'vulnerable' : mode); await f.ready(); f.setMode(mode);
      const result = await f.validate(); expect(result.status).toBe(expected);
      expect(() => f.service.reviewFinding(f.run.id, result.id, true, 'Attempted promotion')).toThrow(/deterministic/);
    }
    expect(f.service.scorecard(f.run.id)).toMatchObject({ errors: 1, findings: { verified: 0 } });
  } finally { await f.close(); }
});

it('requires a trusted browser observation when rendering is part of the owner contract', async () => {
  const f = await fixture();
  try {
    f.configure(true); await f.ready(); await expect(f.validate()).rejects.toThrow(/Readiness/);
    const snapshot = { url: f.readiness.url, text: f.readiness.expectedText };
    const dom = { snapshot, evidence: { ...await f.evidence.put(snapshot, 'playwright', f.owner.id) } };
    await f.service.browserObservation(f.session, f.other.id, dom); await expect(f.validate()).rejects.toThrow(/Readiness/);
    await f.service.browserObservation(f.session, f.owner.id, dom); expect((await f.validate()).status).toBe('verified');
  } finally { await f.close(); }
});

it('rejects fabricated or mismatched coverage evidence and preserves incomplete cells and lead reasons', async () => {
  const f = await fixture();
  try {
    await f.ready(); const cellId = f.run.cells[0]!.id;
    await expect(f.service.cover(f.run.id, cellId, 'tested', 'Invented', [id<'EvidenceId'>()])).rejects.toThrow(/broker/);
    const wrong = await f.broker().request({ url: `${f.base}/objects/0`, method: 'GET', headers: {}, identityId: f.other.id }, f.session, AbortSignal.timeout(5000));
    await expect(f.service.cover(f.run.id, cellId, 'tested', 'Wrong object', [wrong.evidence.id])).rejects.toThrow(/matching/);
    await f.service.cover(f.run.id, cellId, 'blocked', 'Need a second endpoint assertion', []);
    f.service.lead(f.run.id, { key: 'object-ownership', summary: 'Review boundary on second endpoint', reason: 'needs-owner-assertion', cellId });
    expect(() => f.service.control(f.run.id, 'complete', 'Attempted completion')).toThrow(/remain/);
    f.service.waive(f.run.id, cellId, 'Endpoint outside this objective');
    expect(() => f.service.control(f.run.id, 'complete', 'Lead still unresolved')).toThrow(/remain/);
    f.service.lead(f.run.id, { key: 'object-ownership', summary: 'Owner confirmed endpoint outside objective', reason: 'dismissed', cellId });
    expect(f.service.control(f.run.id, 'complete', 'Owner excluded endpoint and lead').state).toBe('completed');
  } finally { await f.close(); }
});

it('preserves coverage, lead backlog and spent engagement requests through restart and requires an explicit resume', async () => {
  const f = await fixture();
  try {
    await f.ready(); const result = await f.validate();
    await f.service.cover(f.run.id, f.run.cells[0]!.id, 'tested', 'Proof replay completed', [result.evidenceIds[1]!]);
    f.service.lead(f.run.id, { key: 'variant', summary: 'Check equivalent endpoint later', reason: 'follow-up' });
    const spent = f.budget.snapshot().requests;
    f.advance(50); await f.reopen();
    expect(f.budget.snapshot().requests).toBe(spent);
    const saved = f.service.get(f.run.id); expect(saved.state).toBe('paused'); expect(saved.cells[0]!.status).toBe('tested');
    expect(saved.leads[0]!.reason).toBe('follow-up'); expect(saved.readiness).toBeUndefined();
    await expect(f.validate()).rejects.toThrow(/paused/);
    f.service.control(f.run.id, 'resume', 'Continue retained backlog'); await expect(f.validate()).rejects.toThrow(/Readiness/);
    expect(f.service.compare(f.run.id, f.run.id)).toMatchObject({ regressed: [], carriedLeads: [{ key: 'variant' }] });
  } finally { await f.close(); }
});

it('protects the validation reserve across child sessions and records failed attempts', async () => {
  const f = await fixture(6);
  try {
    await f.ready();
    const child = id<'SessionId'>(); f.budget.attach(child); f.service.inherit(child, f.session);
    await f.broker().request({ url: `${f.base}/objects/1`, method: 'GET', headers: {}, identityId: f.other.id }, child, AbortSignal.timeout(5000));
    await expect(f.broker().request({ url: `${f.base}/extra`, method: 'GET', headers: {} }, child, AbortSignal.timeout(5000))).rejects.toThrow(/reserve/);
    expect(f.requests).toHaveLength(3);
    expect((await f.validate()).status).toBe('verified'); expect(f.service.get(f.run.id).requests).toBe(6);
  } finally { await f.close(); }
});

it('expires readiness and rejects configuration changes and stale report acceptance', async () => {
  const f = await fixture();
  try {
    await f.ready(); f.advance(1001); await expect(f.validate()).rejects.toThrow(/Readiness/);
    await f.ready(); const result = await f.validate();
    f.service.reviewFinding(f.run.id, result.id, true, 'Reviewed current revision');
    f.revise(); await expect(f.service.report(f.run.id)).rejects.toThrow(/older/);
    expect(() => f.service.reviewFinding(f.run.id, result.id, true, 'Stale review')).toThrow(/current/);
    await expect(f.validate()).rejects.toThrow(/Configuration changed/);
    f.service.control(f.run.id, 'pause', 'Configuration updated'); f.service.control(f.run.id, 'resume', 'Repeat current checks');
    await expect(f.validate()).rejects.toThrow(/Readiness/);
  } finally { await f.close(); }
});

it('verifies retained bytes again before report generation', async () => {
  const f = await fixture();
  try {
    await f.ready(); const finding = await f.validate(); f.service.reviewFinding(f.run.id, finding.id, true, 'Reviewed before corruption');
    const proof = await f.service.proofEvidence(f.run.id, finding.evidenceIds[0]!);
    const metadata = (JSON.parse(proof.text) as { metadata: { pointer: string } }).metadata;
    await writeFile(join(f.root, metadata.pointer), '{"id":"tampered"}');
    await expect(f.service.report(f.run.id)).rejects.toThrow(/digest/);
  } finally { await f.close(); }
});

it('cannot verify an old assertion when the owner changes its contract during replay', async () => {
  const f = await fixture();
  try {
    await f.ready();
    const pending = f.validate();
    f.service.configure(f.run.id, f.readiness, [{ ...f.assertion, expectedValue: 'replacement-object' }]);
    const finding = await pending;
    expect(finding).toMatchObject({ status: 'inconclusive', reviewed: 'pending' });
    expect(finding.reason).toContain('changed during replay');
    expect(() => f.service.reviewFinding(f.run.id, finding.id, true, 'Attempted stale promotion')).toThrow(/current deterministic/);
  } finally { await f.close(); }
});

it('records unknown model costs honestly and detects run-state tampering', async () => {
  const f = await fixture();
  try {
    f.service.recordUsage(f.session, 125); f.service.recordUsage(f.session, undefined);
    expect(f.service.scorecard(f.run.id)).toMatchObject({ model: { calls: 2, reportedTokens: 125, missingUsage: 1, costUsd: null } });
    const db = new DatabaseSync(join(f.root, 'assessment.sqlite'));
    const changed = f.service.get(f.run.id); changed.state = 'completed';
    db.prepare('UPDATE assessment_runs SET body=? WHERE id=?').run(JSON.stringify(changed), f.run.id); db.close();
    await expect(f.reopen()).rejects.toThrow(/audit record/);
  } finally {
    // The reopen failure has already closed the original handle and its rejected replacement.
    await rm(f.root, { recursive: true, force: true });
  }
});

it('recognizes session-ending semantics even when encoded or transported as a GET', () => {
  for (const url of ['https://app.example.test/logout', 'https://app.example.test/a?next=%252Fsign-out', 'https://app.example.test/revoke'])
    expect(endsSession({ url, method: 'GET', headers: {} })).toBe(true);
  expect(endsSession({ url: 'https://app.example.test/logout-help', method: 'GET', headers: {} })).toBe(true);
  expect(endsSession({ url: 'https://app.example.test/objects', method: 'GET', headers: {} })).toBe(false);
});

it('requires an explicit owner decision before a session-ending request reaches transport', async () => {
  const f = await fixture();
  try {
    const input = { url: `${f.base}/logout`, method: 'GET' as const, headers: {} };
    await expect(f.broker().request(input, f.session, AbortSignal.timeout(5000))).rejects.toThrow(); expect(f.requests).toEqual([]);
    let reviewed = 0;
    await f.broker().request(input, f.session, AbortSignal.timeout(5000), async (action, decision) => {
      reviewed++; expect(action.effects).toContain('disrupt'); expect(decision.kind).toBe('ask'); return true;
    });
    expect(reviewed).toBe(1); expect(f.requests).toEqual([input.url]);
  } finally { await f.close(); }
});

it('aborts in-flight brokered work when the owner pauses, and retains its failed outcome', async () => {
  const f = await fixture();
  try {
    f.setMode('stall');
    const request = f.broker().request({ url: `${f.base}/objects/1`, method: 'GET', headers: {} }, f.session, AbortSignal.timeout(5000));
    const rejected = expect(request).rejects.toThrow(/Owner paused/);
    await expect.poll(() => f.requests.length).toBe(1);
    f.service.control(f.run.id, 'pause', 'Owner paused the run'); await rejected;
    expect(f.service.get(f.run.id)).toMatchObject({ state: 'paused', requests: 1, errors: 1 });
    f.service.control(f.run.id, 'resume', 'Continue after interruption'); f.setMode('vulnerable'); await f.ready();
    expect(f.service.get(f.run.id).readiness?.http).toBe(true);
  } finally { await f.close(); }
});

it('persists chat-fork lineage and shares paused state, coverage, leads and budget across restart', async () => {
  const f = await fixture(9);
  try {
    await f.ready();
    const finding = await f.validate();
    await f.service.cover(f.run.id, f.run.cells[0]!.id, 'tested', 'Authorization evidence retained', [finding.evidenceIds[1]!]);
    f.service.lead(f.run.id, { key: 'retained-candidate', summary: 'Check another object with a controlled follow-up', reason: 'follow-up', evidenceIds: [] });
    const child = id<'SessionId'>();
    const lineage = { sourceId: f.session, childId: child, atSeq: 12, replayMessageSeq: 13 };
    const prior = f.service.get(f.run.id);
    f.service.recordFork(lineage);
    expect(f.service.current(child)).toMatchObject({ id: prior.id, requests: prior.requests, cells: prior.cells, leads: prior.leads, findings: prior.findings });
    expect(f.service.forkLineage(child)).toEqual(lineage);
    expect(() => f.service.recordFork({ ...lineage, atSeq: 2 })).toThrow(/lineage/);
    f.service.control(f.run.id, 'pause', 'Paused before replay');
    expect(f.service.signal(child)?.aborted).toBe(true);
    await f.reopen();
    expect(f.service.forkLineage(child)).toEqual(lineage);
    expect(f.service.current(child)).toMatchObject({ id: prior.id, state: 'paused', requests: prior.requests, cells: prior.cells, leads: prior.leads });
    f.service.control(f.run.id, 'resume', 'Resume original budget');
    const input = { url: f.base + '/objects/1', method: 'GET' as const, headers: {} };
    for (let i = prior.requests; i < 6; i++) f.service.before(input, child, `fork-attempt-${i}`);
    expect(() => f.service.before(input, child, 'reserve-attempt')).toThrow(/reserve/);
  } finally { await f.close(); }
});


it('commits branch lineage and shared run membership together or rolls both back', async () => {
  const f = await fixture();
  const db = new DatabaseSync(join(f.root, 'assessment.sqlite'));
  try {
    const child = id<'SessionId'>(), lineage = { sourceId: f.session, childId: child, atSeq: 4 };
    // Simulate a disk-side membership failure after the lineage write begins.
    db.exec(`CREATE TRIGGER refuse_membership BEFORE UPDATE ON assessment_runs
      BEGIN SELECT RAISE(ABORT, 'fixture membership unavailable'); END`);
    expect(() => f.service.recordFork(lineage)).toThrow(/membership unavailable/);
    expect(f.service.forkLineage(child)).toBeUndefined();
    expect(f.service.current(child)).toBeUndefined();
    db.exec('DROP TRIGGER refuse_membership');
    f.service.recordFork(lineage);
    expect(f.service.forkLineage(child)).toEqual(lineage);
    expect(f.service.current(child)?.id).toBe(f.run.id);
    await f.reopen();
    expect(f.service.current(child)?.id).toBe(f.run.id);
  } finally { db.close(); await f.close(); }
});
