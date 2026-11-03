/** Durable assessment state. Only trusted broker observations can satisfy evidence gates. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { canonical, digest, id, PentestError } from '@dsh-pentest/contracts';
import type { Evidence, IdentityId, Json, SessionId } from '@dsh-pentest/contracts';
import type { HttpInput, HttpResult, HttpObserver } from '@dsh-pentest/http';
import type { EvidenceStore, Redactor } from '@dsh-pentest/trajectory';
import { z } from 'zod';

const label = z.string().trim().min(1).max(2000);
export const CellSchema = z.object({
  surface: z.url(), method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']),
  input: z.string().max(200), family: z.enum(['authorization', 'authentication', 'injection', 'session', 'configuration', 'business-logic']),
  identity: z.string().max(128).default('anonymous'),
});
export const PlanSchema = z.object({ title: label, maxRequests: z.number().int().min(6).max(10000),
  validationReserve: z.number().int().min(3).max(100).default(3), cells: z.array(CellSchema).min(1).max(500) });
export const ReadinessSchema = z.object({ url: z.url(), identityId: z.string().uuid().optional(),
  expectedText: z.string().trim().min(3).max(500), browserRequired: z.boolean().default(false),
  ttlMs: z.number().int().min(1000).max(3600000).default(300000) });
/** Owner installs these assertions. Models can select an ID, never an expected result. */
export const AssertionSchema = z.object({ id: z.string().regex(/^[a-z0-9-]{1,64}$/), title: label, url: z.url(),
  ownerIdentityId: z.string().uuid(), otherIdentityId: z.string().uuid().optional(),
  jsonPointer: z.string().regex(/^\//).max(500), expectedValue: z.string().min(1).max(500), negativeControlUrl: z.url() });
export const LeadSchema = z.object({ key: z.string().min(1).max(200), summary: label,
  reason: z.enum(['untested', 'needs-identity', 'needs-owner-assertion', 'infrastructure', 'budget', 'follow-up', 'dismissed', 'resolved']),
  evidenceIds: z.array(z.string().uuid()).max(20).default([]), cellId: z.string().optional() });
type Cell = z.infer<typeof CellSchema> & { id: string; status: 'open' | 'tested' | 'blocked' | 'not-applicable'; reason: string; evidenceIds: string[] };
type Lead = z.infer<typeof LeadSchema> & { updatedAt: string };
type Check = { revision: string; checkedAt: number; http: boolean; anonymousDenied: boolean; browser: boolean; evidenceIds: string[]; reason: string };
export interface Finding {
  id: string; title: string; assertionId: string; status: 'candidate' | 'verified' | 'rejected' | 'inconclusive';
  reason: string; revision: string; evidenceIds: string[]; reviewed: 'pending' | 'accepted' | 'rejected'; reviewReason: string;
}
export interface Run {
  id: string; title: string; createdAt: string; updatedAt: string; revision: string;
  state: 'active' | 'paused' | 'completed' | 'cancelled' | 'failed'; reason: string; sessions: string[];
  maxRequests: number; validationReserve: number; requests: number; errors: number; responses: number;
  modelCalls: number; missingUsage: number; tokens: number;
  readinessContract?: z.infer<typeof ReadinessSchema>; readiness?: Check;
  assertions: z.infer<typeof AssertionSchema>[]; cells: Cell[]; leads: Lead[]; findings: Finding[];
}
interface Observation { runId: string; session: string; input: HttpInput; evidence: Evidence; status: number }
type Phase = 'discovery' | 'readiness' | 'validation';
interface Dependencies {
  revision(): string; checkUrl(url: string): void; hasIdentity(id: string): boolean;
  http(session: SessionId): { request(input: HttpInput, session: SessionId, signal: AbortSignal): Promise<HttpResult> };
  evidence: EvidenceStore; redactor: Redactor; now?: () => number;
}
const terminal = new Set(['completed', 'cancelled', 'failed']);
const fail = (code: string, message: string): never => { throw new PentestError(code, message); };

export class AssessmentService implements HttpObserver {
  private readonly db: DatabaseSync;
  private readonly phase = new AsyncLocalStorage<{ runId: string; phase: Phase }>();
  private readonly busy = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly pending = new Map<string, string>();
  private closed = false;
  private readonly now: () => number;
  constructor(path: string, private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now;
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS assessment_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assessment_observations (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assessment_meta (key TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS assessment_audit (seq INTEGER PRIMARY KEY, body TEXT NOT NULL, hash TEXT NOT NULL);`);
    try { this.verifyAudit(); } catch (error) { this.db.close(); throw error; }
    // A process exit is incomplete work, never successful saturation.
    for (const run of this.runs()) if (run.state === 'active') {
      run.state = 'paused'; run.reason = 'Process ended; resume explicitly and repeat readiness'; delete run.readiness;
      this.save(run, 'recovered');
    }
  }
  private stamp(): string { return new Date(this.now()).toISOString(); }
  budgetState(): { requests: number; startedAt: number } | undefined {
    const row = this.db.prepare('SELECT body FROM assessment_meta WHERE key=?').get('budget');
    return row ? z.object({ requests: z.number().int().min(0), startedAt: z.number().nonnegative() }).parse(JSON.parse(String(row.body))) : undefined;
  }
  saveBudget(value: { requests: number; startedAt: number }): void {
    this.db.prepare('INSERT INTO assessment_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET body=excluded.body').run('budget', canonical(value));
  }
  runs(): Run[] { return this.db.prepare('SELECT body FROM assessment_runs ORDER BY rowid DESC').all().map(row => JSON.parse(String(row.body)) as Run); }
  get(runId: string): Run {
    const row = this.db.prepare('SELECT body FROM assessment_runs WHERE id=?').get(runId);
    return row ? JSON.parse(String(row.body)) as Run : fail('ASSESSMENT_RUN', 'Assessment run does not exist');
  }
  current(session: SessionId): Run | undefined {
    const matches = this.runs().filter(run => run.sessions.includes(session));
    return matches.find(run => !terminal.has(run.state)) ?? matches[0];
  }
  private verifyAudit(): void {
    let previousHash = '0'.repeat(64), seq = 0;
    const latest = new Map<string, string>();
    for (const row of this.db.prepare('SELECT seq,body,hash FROM assessment_audit ORDER BY seq').all()) {
      const record = JSON.parse(String(row.body)) as { runId: string; previousHash: string; stateHash: string };
      if (row.seq !== seq++ || record.previousHash !== previousHash || digest(record) !== row.hash)
        fail('ASSESSMENT_CORRUPT', 'Assessment audit integrity verification failed');
      previousHash = String(row.hash); latest.set(record.runId, record.stateHash);
    }
    for (const run of this.runs()) if (latest.get(run.id) !== digest(run)) fail('ASSESSMENT_CORRUPT', 'Assessment state differs from its audit record');
  }
  private active(runId: string): Run {
    const run = this.get(runId);
    if (run.state !== 'active') fail('ASSESSMENT_INACTIVE', `Run is ${run.state}: ${run.reason}`);
    if (run.revision !== this.deps.revision()) fail('ASSESSMENT_REVISION', 'Configuration changed; pause and resume the run, then repeat readiness');
    return run;
  }
  private save(run: Run, event: string, metadata?: { key: string; body: string }): void {
    run.updatedAt = this.stamp();
    const body = canonical(this.deps.redactor.json(run));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (metadata) this.db.prepare('INSERT OR IGNORE INTO assessment_meta VALUES (?,?)').run(metadata.key, metadata.body);
      this.db.prepare('INSERT INTO assessment_runs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(run.id, body);
      const prior = this.db.prepare('SELECT seq,hash FROM assessment_audit ORDER BY seq DESC LIMIT 1').get();
      const record = canonical({ runId: run.id, event, timestamp: run.updatedAt, stateHash: digest(JSON.parse(body)), previousHash: prior?.hash ?? '0'.repeat(64) });
      this.db.prepare('INSERT INTO assessment_audit VALUES (?,?,?)').run(Number(prior?.seq ?? -1) + 1, record, digest(JSON.parse(record)));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  create(raw: z.input<typeof PlanSchema>, session: SessionId): Run {
    const input = PlanSchema.parse(raw);
    const prior = this.current(session);
    if (prior && !terminal.has(prior.state)) fail('ASSESSMENT_BOUND', 'This chat already belongs to an unfinished run; resume it');
    if (input.validationReserve >= input.maxRequests) fail('ASSESSMENT_BUDGET', 'Leave request capacity for discovery and readiness');
    for (const cell of input.cells) {
      this.deps.checkUrl(cell.surface);
      if (cell.identity !== 'anonymous' && !this.deps.hasIdentity(cell.identity)) fail('IDENTITY_UNKNOWN', 'Coverage identity must be a registered reference or anonymous');
    }
    const cells = [...new Map(input.cells.map(cell => [digest(cell), cell])).values()].map(cell => ({ ...cell,
      id: digest(cell).slice(0, 24), status: 'open' as const, reason: '', evidenceIds: [] }));
    const run: Run = { id: id<'RunId'>(), title: input.title, createdAt: this.stamp(), updatedAt: this.stamp(),
      revision: this.deps.revision(), state: 'active', reason: '', sessions: [session], maxRequests: input.maxRequests,
      validationReserve: input.validationReserve, requests: 0, errors: 0, responses: 0, modelCalls: 0, missingUsage: 0, tokens: 0,
      assertions: [], cells, leads: [], findings: [] };
    this.save(run, 'created'); return this.get(run.id);
  }
  join(runId: string, session: SessionId): Run {
    const run = this.active(runId), prior = this.current(session);
    if (prior && prior.id !== runId && !terminal.has(prior.state)) fail('ASSESSMENT_BOUND', 'Chat belongs to another unfinished run');
    if (!run.sessions.includes(session)) { run.sessions.push(session); this.save(run, 'joined'); }
    return this.get(runId);
  }
  /** Persist ordinary chat-fork lineage separately from subagent parentage. History branches share run membership; fresh replay keeps only provenance. */
  recordFork(input: { sourceId: SessionId; childId: SessionId; atSeq: number; replayMessageSeq?: number; replayHistory?: 'fresh' }): void {
    const key = `fork:${input.childId}`, body = canonical(input);
    const prior = this.db.prepare('SELECT body FROM assessment_meta WHERE key=?').get(key);
    if (prior && prior.body !== body) fail('ASSESSMENT_FORK', 'Branch lineage cannot be replaced');
    const run = this.current(input.sourceId);
    if (input.replayHistory !== 'fresh' && run && !this.current(input.childId)) {
      run.sessions.push(input.childId);
      this.save(run, 'child-inherited', { key, body });
    } else this.db.prepare('INSERT OR IGNORE INTO assessment_meta VALUES (?,?)').run(key, body);
  }
  forkLineage(session: SessionId): { sourceId: SessionId; childId: SessionId; atSeq: number; replayMessageSeq?: number; replayHistory?: 'fresh' } | undefined {
    const row = this.db.prepare('SELECT body FROM assessment_meta WHERE key=?').get(`fork:${session}`);
    return row ? JSON.parse(String(row.body)) : undefined;
  }
  inherit(session: SessionId, parent: SessionId): void {
    const run = this.current(parent); if (!run || this.current(session)) return;
    run.sessions.push(session); this.save(run, 'child-inherited');
  }
  control(runId: string, operation: 'pause' | 'resume' | 'cancel' | 'fail' | 'complete', reason: string): Run {
    const run = this.get(runId); label.parse(reason);
    if (this.busy.has(runId) && operation === 'resume') fail('ASSESSMENT_BUSY', 'Wait for the in-flight operation to settle');
    if (terminal.has(run.state)) fail('ASSESSMENT_TERMINAL', 'Create a new run after a terminal outcome');
    if (operation === 'resume') {
      if (run.state !== 'paused') fail('ASSESSMENT_STATE', 'Only a paused run can resume');
      run.revision = this.deps.revision(); delete run.readiness;
      // Resume keeps coverage and leads, while proofs must be reviewed in the current revision.
      for (const finding of run.findings) finding.reviewed = 'pending';
    }
    if (operation === 'complete') {
      if (this.busy.has(runId) || [...this.pending.values()].includes(runId)) fail('ASSESSMENT_BUSY', 'Wait for all in-flight requests and proofs to settle');
      this.requireReady(run);
      if (run.requests > run.responses + run.errors) fail('ASSESSMENT_INCOMPLETE', 'Interrupted request outcomes remain unknown; record a failed or cancelled run');
      if (run.cells.some(cell => cell.status === 'open' || cell.status === 'blocked') || run.leads.some(lead => !['resolved', 'dismissed'].includes(lead.reason)))
        fail('ASSESSMENT_INCOMPLETE', 'Open/blocked coverage or unresolved leads remain; use pause, cancel or fail to record incomplete work');
    }
    run.state = ({ pause: 'paused', resume: 'active', cancel: 'cancelled', fail: 'failed', complete: 'completed' } as const)[operation];
    run.reason = reason; this.save(run, operation);
    if (operation !== 'resume') this.controllers.get(runId)?.abort(new PentestError('ASSESSMENT_STOPPED', reason));
    return this.get(runId);
  }
  configure(runId: string, raw: z.input<typeof ReadinessSchema>, assertions: z.input<typeof AssertionSchema>[]): Run {
    const run = this.get(runId);
    const contract = ReadinessSchema.parse(raw), checked = z.array(AssertionSchema).max(100).parse(assertions);
    this.deps.checkUrl(contract.url);
    for (const identity of [contract.identityId, ...checked.flatMap(item => [item.ownerIdentityId, item.otherIdentityId])])
      if (identity && !this.deps.hasIdentity(identity)) fail('IDENTITY_UNKNOWN', 'Readiness/assertion identity is not registered');
    if (new Set(checked.map(item => item.id)).size !== checked.length) fail('ASSERTION_DUPLICATE', 'Assertion IDs must be unique');
    for (const assertion of checked) {
      this.deps.checkUrl(assertion.url); this.deps.checkUrl(assertion.negativeControlUrl);
      if (assertion.ownerIdentityId === assertion.otherIdentityId) fail('ASSERTION_IDENTITIES', 'Owner and other identity must differ');
      if (new URL(assertion.url).origin !== new URL(assertion.negativeControlUrl).origin || assertion.url === assertion.negativeControlUrl)
        fail('ASSERTION_CONTROL', 'Use a distinct negative control on the same origin');
    }
    run.readinessContract = contract; run.assertions = checked; delete run.readiness;
    for (const finding of run.findings) { finding.reviewed = 'pending'; finding.status = 'candidate'; finding.reason = 'Owner assertion changed; replay required'; }
    this.save(run, 'owner-configured'); return this.get(runId);
  }
  private readinessRevision(run: Run): string { return digest({ config: this.deps.revision(), contract: run.readinessContract }); }
  private requireReady(run: Run): void {
    const check = run.readiness, contract = run.readinessContract;
    if (!contract || !check || check.revision !== this.readinessRevision(run) || this.now() - check.checkedAt > contract.ttlMs
      || !check.http || contract.identityId && !check.anonymousDenied || contract.browserRequired && !check.browser)
      fail('ASSESSMENT_READINESS', 'Readiness is missing, stale or failed; check the owner contract and repeat the live check');
  }
  async readiness(runId: string, session: SessionId, signal: AbortSignal): Promise<Run> {
    return this.exclusive(runId, async () => {
      const run = this.active(runId), contract = run.readinessContract;
      if (!run.sessions.includes(session)) fail('ASSESSMENT_SESSION', 'Join this run before readiness');
      if (!contract) fail('ASSESSMENT_CONTRACT', 'The owner must configure a readiness URL and expected content in Assessment');
      const c = contract!;
      const results: HttpResult[] = [];
      try {
        await this.phase.run({ runId, phase: 'readiness' }, async () => {
          results.push(await this.deps.http(session).request({ url: c.url, method: 'GET', headers: {}, ...(c.identityId ? { identityId: c.identityId as IdentityId } : {}) }, session, signal));
          if (c.identityId) results.push(await this.deps.http(session).request({ url: c.url, method: 'GET', headers: {} }, session, signal));
        });
        const first = results[0]!, anonymous = results[1];
        const http = success(first) && sameResource(first.url, c.url) && !loginPage(first) && first.body.includes(c.expectedText);
        const anonymousDenied = !c.identityId || Boolean(anonymous && !anonymous.body.includes(c.expectedText) && (anonymous.status === 401 || anonymous.status === 403 || success(anonymous)));
        const latest = this.active(runId);
        if (digest(latest.readinessContract) !== digest(c)) fail('ASSESSMENT_REVISION', 'Readiness contract changed during the check');
        latest.readiness = { revision: this.readinessRevision(latest), checkedAt: this.now(), http, anonymousDenied,
          browser: latest.readiness?.revision === this.readinessRevision(latest) && latest.readiness.browser || false,
          evidenceIds: results.map(result => result.evidence.id), reason: http && anonymousDenied ? 'HTTP contract passed' : 'Protected content or anonymous negative control failed' };
        this.save(latest, 'readiness');
      } catch (error) {
        const latest = this.get(runId); delete latest.readiness; this.save(latest, 'readiness-error'); throw error;
      }
      return this.get(runId);
    });
  }
  /** Called only by the trusted browser adapter, after retaining its DOM evidence. */
  async browserObservation(session: SessionId, identity: IdentityId | undefined, value: Json): Promise<void> {
    const run = this.current(session); if (!run || run.state !== 'active' || !run.readinessContract) return;
    const c = run.readinessContract;
    const parsed = z.object({ evidence: z.object({ id: z.string().uuid(), contentHash: z.string(), pointer: z.string(), mediaType: z.string(),
      tool: z.literal('playwright'), observedAt: z.string(), identityId: z.string().optional() }) }).parse(value);
    const snapshot = z.object({ url: z.url(), text: z.string() }).parse(await this.deps.evidence.read(parsed.evidence as Evidence));
    if ((identity ?? undefined) !== c.identityId || parsed.evidence.identityId !== identity || !sameResource(snapshot.url, c.url) || !snapshot.text.includes(c.expectedText)) return;
    const latest = this.get(run.id), check = latest.readiness;
    if (!check || check.revision !== this.readinessRevision(latest) || digest(latest.readinessContract) !== digest(c) || this.now() - check.checkedAt > c.ttlMs) return;
    check.browser = true; check.evidenceIds.push(parsed.evidence.id); this.save(latest, 'browser-ready');
  }
  /** Shared across HTTP, fuzzing and routed browser requests, including scripts. */
  signal(session: SessionId): AbortSignal | undefined {
    const run = this.current(session); if (!run) return undefined;
    if (run.state !== 'active') return AbortSignal.abort(new PentestError('ASSESSMENT_INACTIVE', 'Assessment is paused'));
    let controller = this.controllers.get(run.id);
    if (!controller || controller.signal.aborted) { controller = new AbortController(); this.controllers.set(run.id, controller); }
    return controller.signal;
  }
  before(input: HttpInput, session: SessionId, actionId: string): void {
    const run = this.current(session); if (!run) return;
    this.active(run.id);
    const phase = this.phase.getStore();
    const reserved = phase?.runId === run.id && phase.phase === 'validation' ? 0 : run.validationReserve;
    if (run.requests >= run.maxRequests - reserved) fail('ASSESSMENT_BUDGET', 'Run request limit reached; discovery cannot spend the validation reserve');
    run.requests++; this.save(run, 'request-reserved'); this.pending.set(actionId, run.id);
  }
  after(input: HttpInput, session: SessionId, result: HttpResult | undefined, actionId: string): void {
    if (this.closed) return; // A closing process leaves any unrecorded outcome explicitly unknown on recovery.
    const runId = this.pending.get(actionId); if (!runId) return;
    this.pending.delete(actionId); const run = this.get(runId);
    if (!result) run.errors++; else {
      run.responses++;
      const observation: Observation = { runId: run.id, session, input, evidence: result.evidence, status: result.status };
      this.db.prepare('INSERT INTO assessment_observations VALUES (?,?,?)').run(result.evidence.id, run.id, canonical(this.deps.redactor.json(observation)));
      if (input.identityId && ([401, 403].includes(result.status) || loginPage(result))) {
        delete run.readiness; run.reason = 'Authenticated request lost access; repeat readiness before validation';
      }
    }
    this.save(run, result ? 'response' : 'request-error');
  }
  private observations(runId: string, evidenceIds: string[]): Observation[] {
    return evidenceIds.map(evidenceId => {
      const row = this.db.prepare('SELECT body FROM assessment_observations WHERE id=? AND run_id=?').get(evidenceId, runId);
      return row ? JSON.parse(String(row.body)) as Observation : fail('ASSESSMENT_EVIDENCE', 'Evidence must come from this run through the HTTP broker');
    });
  }
  async cover(runId: string, cellId: string, status: 'tested' | 'blocked', reason: string, evidenceIds: string[]): Promise<Run> {
    label.parse(reason); const run = this.active(runId), cell = run.cells.find(item => item.id === cellId);
    if (!cell) fail('ASSESSMENT_CELL', 'Coverage cell does not exist');
    if (status === 'tested') {
      this.requireReady(run);
      const observations = this.observations(runId, evidenceIds);
      if (!observations.length || !observations.some(item => item.input.method === cell!.method && sameResource(item.input.url, cell!.surface)
        && (item.input.identityId ?? 'anonymous') === cell!.identity)) fail('ASSESSMENT_EVIDENCE', 'Coverage requires a matching method, URL and identity observation');
      for (const item of observations) await this.deps.evidence.read(item.evidence);
    }
    const latest = this.active(runId);
    if (latest.revision !== run.revision) fail('ASSESSMENT_REVISION', 'Configuration changed during evidence inspection');
    if (status === 'tested') this.requireReady(latest);
    const current = latest.cells.find(item => item.id === cellId)!;
    current.status = status; current.reason = reason; current.evidenceIds = evidenceIds; this.save(latest, 'coverage'); return this.get(runId);
  }
  waive(runId: string, cellId: string, reason: string): Run {
    label.parse(reason); const run = this.get(runId), cell = run.cells.find(item => item.id === cellId);
    if (!cell) fail('ASSESSMENT_CELL', 'Coverage cell does not exist');
    cell!.status = 'not-applicable'; cell!.reason = reason; this.save(run, 'owner-waived'); return this.get(runId);
  }
  lead(runId: string, raw: z.input<typeof LeadSchema>): Run {
    const input = LeadSchema.parse(raw), run = this.active(runId);
    this.observations(runId, input.evidenceIds);
    if (input.cellId && !run.cells.some(item => item.id === input.cellId)) fail('ASSESSMENT_CELL', 'Coverage cell does not exist');
    const prior = run.leads.findIndex(item => item.key === input.key);
    if (prior < 0 && run.leads.length >= 200) fail('ASSESSMENT_LIMIT', 'Lead limit reached; resolve existing leads');
    const lead = { ...input, updatedAt: this.stamp() }; if (prior < 0) run.leads.push(lead); else run.leads[prior] = lead;
    this.save(run, 'lead'); return this.get(runId);
  }
  async validate(runId: string, assertionId: string, session: SessionId, signal: AbortSignal): Promise<Finding> {
    return this.exclusive(runId, async () => {
      const run = this.active(runId); this.requireReady(run);
      const assertion = run.assertions.find(item => item.id === assertionId);
      if (!assertion) fail('ASSERTION_UNKNOWN', 'The owner must install the assertion before it can be replayed');
      if (!run.sessions.includes(session)) fail('ASSESSMENT_SESSION', 'Join the run before validation');
      if (run.maxRequests - run.requests < 3) fail('ASSESSMENT_BUDGET', 'Validation needs at least three remaining request attempts');
      const a = assertion!, results: HttpResult[] = [];
      const finding: Finding = { id: run.findings.find(item => item.assertionId === assertionId)?.id ?? id<'FindingId'>(), title: a.title,
        assertionId, status: 'inconclusive', reason: '', revision: digest({ run: run.revision, assertion: a }), evidenceIds: [], reviewed: 'pending', reviewReason: '' };
      try {
        await this.phase.run({ runId, phase: 'validation' }, async () => {
          for (const input of [
            { url: a.url, identityId: a.ownerIdentityId }, { url: a.url, ...(a.otherIdentityId ? { identityId: a.otherIdentityId } : {}) },
            { url: a.negativeControlUrl, ...(a.otherIdentityId ? { identityId: a.otherIdentityId } : {}) },
          ]) results.push(await this.deps.http(session).request({ ...input, method: 'GET', headers: {} } as HttpInput, session, signal));
        });
        const [owner, other, control] = results as [HttpResult, HttpResult, HttpResult];
        for (const result of results) await this.deps.evidence.read(result.evidence);
        const baseline = success(owner) && sameResource(owner.url, a.url) && !loginPage(owner) && jsonAt(owner.body, a.jsonPointer) === a.expectedValue;
        const replay = success(other) && sameResource(other.url, a.url) && !loginPage(other) && jsonAt(other.body, a.jsonPointer) === a.expectedValue;
        const negative = sameResource(control.url, a.negativeControlUrl) && !loginPage(control)
          && ([403, 404].includes(control.status) || success(control) && jsonAt(control.body, a.jsonPointer) !== undefined && jsonAt(control.body, a.jsonPointer) !== a.expectedValue);
        if (baseline && replay && negative) { finding.status = 'verified'; finding.reason = 'Owner object, unauthorized replay and distinct negative control all passed'; }
        else if (baseline && [401, 403].includes(other.status)) { finding.status = 'rejected'; finding.reason = 'Other identity was denied access'; }
        else finding.reason = 'Baseline, replay or negative control was inconclusive; successful status alone is insufficient';
      } catch (error) { finding.reason = this.deps.redactor.text(error instanceof Error ? error.message : 'Infrastructure failure'); }
      finding.evidenceIds = results.map(result => result.evidence.id);
      const latest = this.get(runId), index = latest.findings.findIndex(item => item.id === finding.id);
      if (run.revision !== this.deps.revision() || digest(latest.assertions.find(item => item.id === assertionId) ?? null) !== digest(a)
        || digest(latest.readinessContract ?? null) !== digest(run.readinessContract ?? null)) {
        finding.status = 'inconclusive'; finding.reason = 'Configuration or owner contract changed during replay; repeat readiness and validation';
      }
      if (index < 0) latest.findings.push(finding); else latest.findings[index] = finding;
      this.save(latest, 'validated'); return finding;
    });
  }
  reviewFinding(runId: string, findingId: string, accept: boolean, reason: string): Run {
    label.parse(reason); const run = this.get(runId), finding = run.findings.find(item => item.id === findingId);
    if (!finding) fail('ASSESSMENT_FINDING', 'Finding does not exist');
    const assertion = run.assertions.find(item => item.id === finding!.assertionId);
    if (accept && (finding!.status !== 'verified' || run.revision !== this.deps.revision() || !assertion
      || finding!.revision !== digest({ run: run.revision, assertion }))) fail('ASSESSMENT_GATE', 'Only a current deterministic proof can be accepted');
    finding!.reviewed = accept ? 'accepted' : 'rejected'; finding!.reviewReason = reason;
    this.save(run, 'owner-reviewed'); return this.get(runId);
  }
  recordUsage(session: SessionId, tokens: number | undefined): void {
    if (this.closed) return;
    const run = this.current(session); if (!run || run.state !== 'active') return;
    run.modelCalls++; if (tokens === undefined || !Number.isFinite(tokens) || tokens < 0) run.missingUsage++; else run.tokens += tokens;
    this.save(run, 'model-usage');
  }
  scorecard(runId: string): Json {
    const run = this.get(runId), counts = (status: Cell['status']) => run.cells.filter(cell => cell.status === status).length;
    const alerts: string[] = [];
    try { this.requireReady(run); } catch { alerts.push('Readiness missing, expired or failed'); }
    if (run.errors) alerts.push(`${run.errors} request failures; infrastructure is not a security finding`);
    if (run.requests > run.responses + run.errors) alerts.push('Some reserved request outcomes are pending or interrupted');
    if (run.cells.some(cell => cell.status === 'blocked' || cell.status === 'open')) alerts.push('Coverage is incomplete');
    if (run.leads.some(lead => !['resolved', 'dismissed'].includes(lead.reason))) alerts.push('Unresolved leads remain');
    if (run.requests >= run.maxRequests - run.validationReserve) alerts.push('Discovery budget exhausted; validation reserve protected');
    if (run.missingUsage) alerts.push('Some model calls omitted usage; total cost is unknown');
    return this.deps.redactor.json({ runId, state: run.state, reason: run.reason, requests: run.requests, responses: run.responses, errors: run.errors,
      coverage: { total: run.cells.length, tested: counts('tested'), waived: counts('not-applicable'), open: counts('open'), blocked: counts('blocked') },
      findings: { verified: run.findings.filter(item => item.status === 'verified').length, accepted: run.findings.filter(item => item.reviewed === 'accepted').length },
      model: { calls: run.modelCalls, reportedTokens: run.tokens, missingUsage: run.missingUsage, costUsd: null }, alerts,
      completion: run.state === 'completed' ? 'declared plan completed' : 'incomplete; no claim of target safety' });
  }
  compare(runId: string, baselineId: string): Json {
    const current = this.get(runId), baseline = this.get(baselineId);
    const a = new Map(current.cells.map(cell => [cell.id, cell])), b = new Map(baseline.cells.map(cell => [cell.id, cell]));
    return this.deps.redactor.json({ runId, baselineId, comparableConfiguration: current.revision === baseline.revision,
      regressed: baseline.cells.filter(cell => cell.status === 'tested' && a.get(cell.id)?.status !== 'tested').map(cell => cell.id),
      added: current.cells.filter(cell => !b.has(cell.id)).map(cell => cell.id),
      carriedLeads: baseline.leads.filter(lead => !['resolved', 'dismissed'].includes(lead.reason)),
      requestDelta: current.requests - baseline.requests, errorDelta: current.errors - baseline.errors });
  }
  async report(runId: string): Promise<{ json: Json; markdown: string }> {
    const run = this.get(runId);
    const findings = run.findings.filter(item => item.status === 'verified' && item.reviewed === 'accepted');
    if (findings.length && run.revision !== this.deps.revision()) fail('ASSESSMENT_REVISION', 'Report proofs belong to an older configuration');
    const evidence: { metadata: Evidence; value: Json }[] = [];
    for (const finding of findings) for (const item of this.observations(runId, finding.evidenceIds)) {
      evidence.push({ metadata: item.evidence, value: await this.deps.evidence.read(item.evidence) });
    }
    const scorecard = this.scorecard(runId), unresolved = run.leads.filter(lead => !['resolved', 'dismissed'].includes(lead.reason));
    const json = this.deps.redactor.json({ schemaVersion: 1, runId, title: run.title, state: run.state, scorecard, findings,
      unresolvedLeads: unresolved, coverage: run.cells, evidence });
    const markdown = [`# ${plain(run.title)}`, '', `Run: ${runId} · ${run.state}`, '',
      'Only deterministically verified findings accepted by the owner are included. Coverage describes the declared plan; it does not establish target safety.', '',
      ...findings.flatMap(finding => [`## ${plain(finding.title)}`, '', plain(finding.reason), '', `Evidence: ${finding.evidenceIds.join(', ')}`, '', `Review: ${plain(finding.reviewReason)}`, '']),
      '## Coverage and limitations', '', `Tested ${run.cells.filter(cell => cell.status === 'tested').length}/${run.cells.length} declared cells.`,
      `Unresolved leads: ${unresolved.length}. Failed requests: ${run.errors}. Model cost: unknown.`, '',
      '```json', JSON.stringify(scorecard, null, 2), '```', ''].join('\n');
    return { json, markdown: this.deps.redactor.text(markdown) };
  }
  async proofEvidence(runId: string, evidenceId: string, offset = 0): Promise<{ text: string; nextOffset: number | null }> {
    const item = this.observations(runId, [evidenceId])[0]!;
    const text = JSON.stringify(this.deps.redactor.json({ request: item.input, metadata: item.evidence, response: await this.deps.evidence.read(item.evidence) }), null, 2);
    if (!Number.isInteger(offset) || offset < 0 || offset > text.length) fail('ASSESSMENT_PAGE', 'Invalid evidence page');
    return { text: text.slice(offset, offset + 16384), nextOffset: offset + 16384 < text.length ? offset + 16384 : null };
  }
  private async exclusive<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    if (this.busy.has(runId)) fail('ASSESSMENT_BUSY', 'Another readiness or validation operation is running');
    this.busy.add(runId); try { return await operation(); } finally { this.busy.delete(runId); }
  }
  close(): void { if (this.closed) return; this.closed = true; for (const controller of this.controllers.values()) controller.abort(); this.db.close(); }
}
const success = (result: HttpResult): boolean => result.status >= 200 && result.status < 300;
function sameResource(a: string, b: string): boolean { const x = new URL(a), y = new URL(b); x.hash = ''; y.hash = ''; x.searchParams.sort(); y.searchParams.sort(); return x.href === y.href; }
function loginPage(result: HttpResult): boolean {
  return /\/(?:login|signin|sign-in)(?:[/?#]|$)/i.test(result.url) || /<input\b[^>]*type\s*=\s*["']?password\b/i.test(result.body);
}
function jsonAt(body: string, pointer: string): unknown {
  try {
    let value: unknown = JSON.parse(body);
    for (const segment of pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
      value = (value as Record<string, unknown>)[segment];
    }
    return value;
  } catch { return undefined; }
}
const plain = (text: string): string => text.replace(/[\r\n`<>\[\]!*#]/g, ' ');
