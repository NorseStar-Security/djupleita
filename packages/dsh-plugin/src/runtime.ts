/** Engagement-scoped service composition; no changes to DSH's shared agent loop. */
import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { EngagementSchema, ScopeSchema, PentestError, id, freeze, digest } from '@dsh-pentest/contracts';
import type { Action, Effect, IdentityId, Engagement, JudgmentProvider, Json, ModelSelection, SessionId, Scope } from '@dsh-pentest/contracts';
import { EngagementService } from '@dsh-pentest/engagement';
import { ScopeService } from '@dsh-pentest/scope';
import { PolicyConfigSchema, PolicyService, JevJudge } from '@dsh-pentest/policy';
import type { PolicyConfig } from '@dsh-pentest/policy';
import { EvidenceStore, Redactor, TrajectoryStore, previewData } from '@dsh-pentest/trajectory';
import { IdentityService, MacKeychainProvider, IdentitySchema } from '@dsh-pentest/identities';
import type { Identity, SecretProvider } from '@dsh-pentest/identities';
import { HttpBroker, ServiceJsonClient } from '@dsh-pentest/http';
import { AttackGraph } from '@dsh-pentest/graph';
import { CrawlFrontier, CrawlService } from '@dsh-pentest/crawl';
import { AuthzService } from '@dsh-pentest/authz';
import { AssessmentService } from '@dsh-pentest/assessment';
import { BrowserService } from '@dsh-pentest/browser';
import { ReconService, ReconConfigSchema, PassiveConfigSchema, PassiveReconService, installReconTools } from '@dsh-pentest/recon';
import { FuzzService, FuzzConfigSchema, installFfuf as installFfufTool } from '@dsh-pentest/fuzz';
import { ReaService, ReaConfigSchema, installRea as installReaTools } from '@dsh-pentest/rea';
import { OtlpExporter, ExportConfigSchema } from '@dsh-pentest/export';
import { LearningService, LearningConfigSchema, RankingSchema } from '@dsh-pentest/learning';
import type { Ranking } from '@dsh-pentest/learning';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import { z } from 'zod';
import { ReviewService } from './review.ts';
import type { ReviewOrigin } from './review.ts';
import { inspectTools } from './setup.ts';
import type { SetupEntry, ToolSetup } from './setup.ts';

export interface EffectDescriptor {
  plugin: string;
  /** Trusted adapter declaration, never an argument supplied by the model. */
  confinement: 'brokered' | 'local-read' | 'transport';
  describe(args: unknown): { destinations: Action['destinations']; effects: Effect[]; reversible: boolean; identityId?: IdentityId };
}
export interface RuntimeConfig {
  engagement: Engagement; policy: PolicyConfig; root: string; keychainHelper: string;
  /** Embedders/tests may supply an alternative secret store without changing identity handling. */
  secrets?: SecretProvider;
  plugins?: PluginConfig;
  /** Trusted distribution path for owner-initiated dependency installation. */
  distributionRoot?: string;
}
export const PluginConfigSchema = z.object({
  browser: z.object({ executable: z.string().optional(), headless: z.boolean().default(true) }).default({ headless: true }),
  recon: ReconConfigSchema.default({ binaries: {}, sources: ['crtsh'], timeoutMs: 120000 }),
  ffuf: FuzzConfigSchema.default({ wordlists: {}, timeoutMs: 300000 }),
  intelligence: PassiveConfigSchema.default({ dohEndpoint: 'https://dns.google/resolve' }),
  rea: ReaConfigSchema.optional(), learning: LearningConfigSchema.optional(), telemetry: ExportConfigSchema.optional(),
});
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
/** Apply only fields actually present in a setup file; schema defaults must not reset other settings. */
function mergeLocalSetup(base: PluginConfig, raw: unknown): PluginConfig {
  const local = z.record(z.string(), z.unknown()).parse(raw);
  const group = (key: string): Record<string, unknown> => local[key] === undefined ? {} : z.record(z.string(), z.unknown()).parse(local[key]);
  const recon = group('recon');
  return PluginConfigSchema.parse({ ...base, ...local,
    browser: { ...base.browser, ...group('browser') }, intelligence: { ...base.intelligence, ...group('intelligence') },
    ffuf: { ...base.ffuf, ...group('ffuf'), wordlists: { ...base.ffuf.wordlists,
      ...z.record(z.string(), z.string()).parse(group('ffuf').wordlists ?? {}) } },
    recon: { ...base.recon, ...recon, binaries: { ...base.recon.binaries,
      ...z.record(z.string(), z.unknown()).parse(recon.binaries ?? {}) } },
  });
}

export class PentestRuntime {
  readonly redactor = new Redactor();
  readonly engagement: EngagementService;
  readonly review: ReviewService;
  private currentScope: ScopeService;
  private currentPolicy: PolicyConfig;
  private currentPlugins: PluginConfig;
  private currentRanking: Ranking = { auth: 4, object: 3, query: 2, novelty: 1 };
  private browserService?: BrowserService;
  private reaService?: ReaService;
  private exporter?: OtlpExporter;
  private learningService?: LearningService;
  private exportError?: string;
  private revision = new AbortController();
  readonly trajectories: TrajectoryStore;
  readonly evidence: EvidenceStore;
  readonly assessment: AssessmentService;
  readonly identities: IdentityService;
  readonly graph: AttackGraph;
  private currentFrontier: CrawlFrontier;
  readonly root: string;
  private readonly selectedModels = new Map<SessionId, Readonly<ModelSelection>>();
  private readonly descriptors = new Map<string, EffectDescriptor>();
  private readonly unsubscriptions = new Set<() => void>();
  private metadataQueue = Promise.resolve();
  private settingsQueue = Promise.resolve();
  private releaseWriter?: () => Promise<void>;
  private closing = false;
  private toolStatus?: Promise<SetupEntry[]>;
  private installing = false;
  private readonly setupAbort = new AbortController();
  get scope(): ScopeService { return this.currentScope; }
  get frontier(): CrawlFrontier { return this.currentFrontier; }

  private constructor(readonly config: RuntimeConfig, private readonly judge: JudgmentProvider) {
    EngagementSchema.parse(config.engagement); PolicyConfigSchema.parse(config.policy);
    this.root = resolve(config.root, config.engagement.id);
    this.review = new ReviewService(this.root, () => digest({ scope: this.scope.version, policy: this.currentPolicy, plugins: this.currentPlugins }), { append: (session, type, data) => this.trajectories.append(session, type, data) }, value => this.redactor.json(value));
    this.currentScope = new ScopeService(config.engagement.scope, undefined, this.review);
    this.currentPolicy = freeze(PolicyConfigSchema.parse(config.policy));
    this.currentPlugins = freeze(PluginConfigSchema.parse(config.plugins ?? {}));
    this.trajectories = new TrajectoryStore(join(this.root, 'trajectories'), config.engagement.id, this.redactor);
    this.evidence = new EvidenceStore(this.root, this.redactor);
    this.identities = new IdentityService(config.engagement.id, config.secrets ?? new MacKeychainProvider(resolve(config.keychainHelper)), this.redactor);
    this.graph = new AttackGraph(join(this.root, 'graph.sqlite'), config.engagement.id);
    this.assessment = new AssessmentService(join(this.root, 'assessment.sqlite'), {
      revision: () => this.assessmentRevision(), checkUrl: url => { this.scope.check({ url, purpose: 'target' }); },
      hasIdentity: identity => this.identities.list().some(item => item.id === identity),
      http: session => this.http(session), evidence: this.evidence, redactor: this.redactor,
    });
    const initial = this.assessment.budgetState();
    this.engagement = new EngagementService(config.engagement, Date.now, {
      ...(initial ? { initial } : {}), save: value => this.assessment.saveBudget(value),
    });
    this.currentFrontier = new CrawlFrontier({ maxPages: Math.min(500, config.engagement.budget.requests),
      maxDepth: config.engagement.budget.maxDepth, maxQueued: 10000, maxPerTemplate: 3, stalePageLimit: 25 }, this.scope);
  }

  static async open(config: RuntimeConfig, judge: JudgmentProvider): Promise<PentestRuntime> {
    EngagementSchema.parse(config.engagement);
    await mkdir(resolve(config.root, config.engagement.id), { recursive: true, mode: 0o700 });
    const lockPath = resolve(config.root, config.engagement.id, 'writer.lock');
    const lock = await open(lockPath, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST') throw new PentestError('ENGAGEMENT_IN_USE', `Engagement already has a writer. Close the other desktop/web process. After a crash, verify the PID in ${lockPath} has exited before removing that lock.`);
      throw error;
    });
    await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await lock.sync(); await lock.close();
    let runtime: PentestRuntime;
    try { runtime = new PentestRuntime(config, judge); }
    catch (error) { await unlink(lockPath); throw error; }
    runtime.releaseWriter = () => unlink(lockPath);
    try {
      try {
        const saved = z.object({ scope: ScopeSchema, policy: PolicyConfigSchema, ranking: RankingSchema.optional() }).parse(JSON.parse(await readFile(join(runtime.root, 'settings.json'), 'utf8')));
        runtime.currentScope = new ScopeService(saved.scope, undefined, runtime.review); runtime.currentPolicy = freeze(saved.policy);
        if (saved.ranking) runtime.currentRanking = freeze(saved.ranking);
        runtime.currentFrontier = new CrawlFrontier(runtime.frontier.config, runtime.scope, runtime.currentRanking);
      } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      try {
        const saved = PluginConfigSchema.parse(JSON.parse(await readFile(join(runtime.root, 'plugins.json'), 'utf8')));
        // A fresh installation fills absent mappings in an existing engagement.
        runtime.currentPlugins = freeze({ ...saved, ffuf: { ...saved.ffuf,
          ...(saved.ffuf.binary ?? runtime.currentPlugins.ffuf.binary ? { binary: saved.ffuf.binary ?? runtime.currentPlugins.ffuf.binary! } : {}) }, recon: { ...saved.recon,
          binaries: { ...runtime.currentPlugins.recon.binaries, ...saved.recon.binaries } } });
      }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await runtime.review.load();
      const metadata = z.array(IdentitySchema).parse(JSON.parse(await readFile(join(runtime.root, 'identities.json'), 'utf8')));
      for (const identity of metadata) runtime.identities.restore(identity as Identity);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) { runtime.graph.close(); runtime.assessment.close(); await runtime.releaseWriter(); throw error; }
    }
    return runtime;
  }

  attach(sessionId: SessionId, model?: Readonly<ModelSelection>, parent?: SessionId): void {
    this.engagement.attach(sessionId);
    if (parent) this.assessment.inherit(sessionId, parent);
    if (model) this.selectedModels.set(sessionId, { provider: model.provider, model: model.model });
  }
  session(exec: ToolExecution): SessionId {
    if (!exec.agent) throw new PentestError('SESSION_UNBOUND', 'Pentest tools require a DSH chat');
    const sessionId = exec.agent.id as unknown as SessionId;
    const parent = exec.agent.session?.header.parentSession;
    if (parent) this.assessment.inherit(sessionId, parent as unknown as SessionId);
    this.engagement.attach(sessionId);
    if (!this.selectedModels.has(sessionId)) {
      const model = exec.agent.model?.current();
      if (model) this.selectedModels.set(sessionId, { provider: model.provider, model: model.model });
    }
    return sessionId;
  }
  model(session: SessionId): Readonly<ModelSelection> { return this.selectedModels.get(session) ?? this.config.engagement.model; }
  signal(signal: AbortSignal): AbortSignal { return AbortSignal.any([signal, this.revision.signal]); }
  policy(session: SessionId): PolicyService {
    const selected = this.currentPolicy.judge;
    const provider = selected?.kind === 'jev' ? new JevJudge((url, body, signal) => this.services().send(url, 'model', body,
      signal, selected.identityId as import('@dsh-pentest/contracts').IdentityId | undefined), selected.model ?? 'jev-latest', selected.fallback ? this.judge : undefined) : this.judge;
    return new PolicyService(this.currentPolicy, this.scope, provider, this.model(session), this.trajectories, this.redactor);
  }
  /** One origin spans the guard and dispatch, so nested checks share only this call's grants. */
  reviewOrigin(exec: ToolExecution): ReviewOrigin {
    return { sessionId: this.session(exec), tool: exec.name, callId: String(exec.callId),
      argumentsHash: digest(exec.arguments), arguments: this.redactor.json(exec.arguments), grants: new Set() };
  }
  approve: import('@dsh-pentest/policy').ApprovalAnswerer = async (action, decision, signal) =>
    this.review.request(action.plugin === 'unadapted' ? 'adapter' : 'policy',
      { plugin: action.plugin, destinations: action.destinations, effects: action.effects, reversible: action.reversible,
        identityId: action.identityId ?? null, source: decision.source, policyVersion: decision.policyVersion }, decision.reasons.join('; '), signal);

  http(session: SessionId): HttpBroker {
    return new HttpBroker({ timeoutMs: 30000, maxRedirects: 5, maxRequestBytes: 4 * 1024 * 1024 },
      this.engagement, this.scope, this.policy(session), this.identities, this.trajectories, this.evidence, this.redactor, undefined, this.revision.signal, this.approve, this.assessment);
  }
  assessmentRevision(): string { return digest({ scope: this.scope.version, policy: this.currentPolicy, plugins: this.currentPlugins,
    identities: this.identities.list(), budget: this.config.engagement.budget }); }
  crawl(session: SessionId): CrawlService { return new CrawlService(this.frontier, this.http(session), this.graph); }
  authz(session: SessionId): AuthzService { return new AuthzService(this.http(session), this.identities, this.graph, this.trajectories); }
  services(): ServiceJsonClient { return new ServiceJsonClient(this.scope, this.identities, this.redactor); }
  browser(): BrowserService {
    return this.browserService ??= new BrowserService({ ...this.currentPlugins.browser, root: join(this.root, 'browser') }, this.scope,
      session => this.http(session), this.identities, this.trajectories, this.evidence, this.redactor, session => this.crawl(session), this.revision.signal);
  }
  recon(): ReconService { return new ReconService(this.currentPlugins.recon, join(this.root, 'recon'), this.scope,
    this.engagement, this.graph, this.evidence, this.trajectories, this.redactor, session => this.crawl(session)); }
  fuzz(): FuzzService { return new FuzzService(this.currentPlugins.ffuf, join(this.root, 'ffuf'), this.engagement,
    session => this.http(session), session => this.crawl(session), this.evidence, this.trajectories, this.redactor); }
  intelligence(): PassiveReconService { return new PassiveReconService(this.currentPlugins.intelligence, this.scope, this.engagement,
    (url, signal, identity) => this.services().send(url, 'intelligence', null, signal, identity, 'GET'), this.graph, this.evidence,
    this.trajectories, this.redactor, session => this.crawl(session)); }
  rea(): ReaService {
    if (!this.currentPlugins.rea) throw new PentestError('REA_CONFIG', 'Configure REA in the Plugins panel before using its tools');
    return this.reaService ??= new ReaService(this.currentPlugins.rea, join(this.root, 'rea'), this.graph, this.evidence,
      this.trajectories, this.redactor, session => this.crawl(session));
  }
  learning(): LearningService {
    if (!this.currentPlugins.learning) throw new PentestError('LEARNING_CONFIG', 'Configure the Optuna Python environment in the Plugins panel');
    return this.learningService ??= new LearningService(this.currentPlugins.learning, join(this.root, 'studies'), this.trajectories, this.redactor);
  }
  /** Plugin-owned background work remains optional and never removes local trajectories. */
  async exportTick(signal: AbortSignal): Promise<void> {
    const config = this.currentPlugins.telemetry;
    if (!config?.enabled) return;
    const destination = config.courseAudit ? digest({ endpoint: config.endpoint, courseAudit: config.courseAudit }) : digest(config.endpoint);
    const exporter = this.exporter ??= new OtlpExporter(join(this.root, 'outbox', destination), config, this.services(), this.redactor);
    try { await exporter.capture(this.trajectories); await exporter.drain(AbortSignal.any([signal, this.revision.signal])); delete this.exportError; }
    catch (error) { this.exportError = this.redactor.text(error instanceof Error ? error.message : 'Telemetry export failed'); }
  }

  registerDescriptor(tool: string, descriptor: EffectDescriptor): () => void {
    if (this.descriptors.has(tool)) throw new PentestError('DESCRIPTOR_EXISTS', 'Tool already has an effect descriptor');
    this.descriptors.set(tool, descriptor);
    return () => { if (this.descriptors.get(tool) === descriptor) this.descriptors.delete(tool); };
  }
  describe(exec: ToolExecution): Action {
    const sessionId = this.session(exec);
    const descriptor = this.descriptors.get(exec.name);
    const effects = descriptor?.describe(exec.arguments) ?? { destinations: [], effects: ['unknown'] as Effect[], reversible: false };
    return { id: id<'ActionId'>(), engagementId: this.config.engagement.id, sessionId, tool: exec.name,
      plugin: descriptor?.plugin ?? 'unadapted', arguments: this.redactor.json(exec.arguments), ...effects,
      parentId: String(exec.rootCallId) };
  }
  inventory(): { tool: string; plugin: string; confinement: string }[] {
    return [...this.descriptors].map(([tool, descriptor]) => ({ tool, plugin: descriptor.plugin, confinement: descriptor.confinement }));
  }

  async createIdentity(metadata: Omit<Identity, 'id'>, secret: string, signal?: AbortSignal): Promise<Readonly<Identity>> {
    if (this.closing) throw new PentestError('RUNTIME_CLOSED', 'Engagement is closing');
    const identity = await this.identities.create(metadata, secret, signal);
    const snapshot = this.identities.list();
    const next = this.metadataQueue.then(async () => {
      const path = join(this.root, 'identities.json');
      const temporary = `${path}.${id<'WriteId'>()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    });
    this.metadataQueue = next.catch(() => {});
    await next;
    return identity;
  }

  /** Called only by owner UI/RPC. Revoke in-flight work before exposing a new scope/policy revision. */
  async updateSettings(scope: Scope, policy: PolicyConfig, operatorSession: SessionId, ranking: Ranking = this.currentRanking): Promise<void> {
    if (this.closing) throw new PentestError('RUNTIME_CLOSED', 'Engagement is closing');
    const checkedRanking = freeze(RankingSchema.parse(ranking));
    const checkedScope = new ScopeService(scope, undefined, this.review), checkedPolicy = freeze(PolicyConfigSchema.parse(policy));
    const next = this.settingsQueue.then(async () => {
      const path = join(this.root, 'settings.json'), temporary = `${path}.${id<'WriteId'>()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ scope: checkedScope.scope, policy: checkedPolicy, ranking: checkedRanking })}\n`, { mode: 0o600 });
      await this.trajectories.append(operatorSession, 'engagement/settings', this.redactor.json({
        source: 'desktop-owner', previousScope: this.scope.version, scope: checkedScope.scope, policy: checkedPolicy, ranking: checkedRanking,
      }));
      await rename(temporary, path);
      this.review.cancel();
      this.revision.abort(new PentestError('POLICY_REVISED', 'Engagement scope or policy changed in the desktop UI'));
      await this.browserService?.close(); delete this.browserService; await this.reaService?.close(); delete this.reaService; delete this.exporter;
      this.revision = new AbortController(); this.currentScope = checkedScope; this.currentPolicy = checkedPolicy; this.currentRanking = checkedRanking;
      this.currentFrontier = new CrawlFrontier(this.frontier.config, checkedScope, this.currentRanking);
    });
    this.settingsQueue = next.catch(() => {}); await next;
  }
  async updatePlugins(config: PluginConfig, session: SessionId): Promise<void> {
    if (this.closing) throw new PentestError('RUNTIME_CLOSED', 'Engagement is closing');
    const checked = freeze(PluginConfigSchema.parse(config));
    const next = this.settingsQueue.then(async () => {
      const path = join(this.root, 'plugins.json'), temporary = `${path}.${id<'WriteId'>()}.tmp`;
      await writeFile(temporary, JSON.stringify(checked), { mode: 0o600 });
      await this.trajectories.append(session, 'plugins/settings', this.redactor.json({ source: 'desktop-owner', config: checked }));
      await rename(temporary, path);
      this.review.cancel(); this.revision.abort(); await this.browserService?.close(); delete this.browserService;
      await this.reaService?.close(); delete this.reaService; delete this.learningService; delete this.exporter;
      this.revision = new AbortController(); this.currentPlugins = checked;
      delete this.toolStatus;
    }); this.settingsQueue = next.catch(() => {}); await next;
  }
  async toolSetup(refresh = false): Promise<ToolSetup> {
    if (refresh) delete this.toolStatus;
    const config = this.currentPlugins;
    const entries = await (this.toolStatus ??= Promise.all([this.recon().doctor(), this.fuzz().doctor()])
      .then(([recon, ffuf]) => inspectTools(config, recon, ffuf)));
    return { installing: this.installing, installAvailable: Boolean(this.config.distributionRoot), entries };
  }
  /** Owner UI only: fixed official releases, with no model-controlled paths or URLs. */
  async installRecon(session: SessionId, signal: AbortSignal): Promise<void> {
    await this.installManaged('recon', session, signal);
  }
  async installFfuf(session: SessionId, signal: AbortSignal): Promise<void> {
    await this.installManaged('ffuf', session, signal);
  }
  async installRea(session: SessionId, signal: AbortSignal): Promise<void> {
    await this.installManaged('rea', session, signal);
  }
  private async installManaged(kind: 'recon' | 'ffuf' | 'rea', session: SessionId, signal: AbortSignal): Promise<void> {
    if (!this.config.distributionRoot) throw new PentestError('SETUP_ROOT', `Restart Djupleita to enable managed tool setup, or run pnpm setup:tools --only ${kind}.`);
    if (this.closing || this.installing) throw new PentestError('SETUP_BUSY', 'Tool setup is already running or the engagement is closing');
    this.installing = true;
    try {
      const lifetime = AbortSignal.any([signal, this.setupAbort.signal, AbortSignal.timeout(15 * 60 * 1000)]);
      const installed = kind === 'recon' ? { binaries: await installReconTools(this.config.distributionRoot, lifetime) }
        : kind === 'ffuf' ? { binary: await installFfufTool(this.config.distributionRoot, lifetime) }
        : { ...this.currentPlugins.rea, ...await installReaTools(this.config.distributionRoot, lifetime),
          roots: this.currentPlugins.rea?.roots ?? [join(this.config.distributionRoot, '.pentest/analysis')],
          timeoutMs: this.currentPlugins.rea?.timeoutMs ?? 240000 };
      if (kind === 'rea' && !this.currentPlugins.rea?.roots.length) await mkdir(join(this.config.distributionRoot, '.pentest/analysis'), { recursive: true, mode: 0o700 });
      const path = join(this.config.distributionRoot, '.pentest/tooling.json');
      const local = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; })));
      const updated = { ...local, [kind]: { ...z.record(z.string(), z.unknown()).parse(local[kind] ?? {}), ...installed } };
      mergeLocalSetup(PluginConfigSchema.parse({}), updated);
      const temporary = `${path}.${id<'WriteId'>()}.tmp`;
      await writeFile(temporary, JSON.stringify(updated, null, 2), { mode: 0o600 }); await rename(temporary, path);
      await this.updatePlugins(mergeLocalSetup(this.currentPlugins, { [kind]: installed }), session);
    } finally { this.installing = false; delete this.toolStatus; }
  }
  /** Import local runtimes into the active engagement, without restarting the app. */
  async loadLocalSetup(session: SessionId): Promise<void> {
    if (!this.config.distributionRoot) throw new PentestError('SETUP_ROOT', 'Restart Djupleita to enable local setup import.');
    const local: unknown = JSON.parse(await readFile(join(this.config.distributionRoot, '.pentest/tooling.json'), 'utf8'));
    await this.updatePlugins(mergeLocalSetup(this.currentPlugins, local), session);
  }
  async promoteStudy(runId: string, session: SessionId): Promise<void> {
    const ranking = await this.learning().promotion(runId, session);
    await this.updateSettings(this.scope.scope, this.currentPolicy, session, ranking);
  }
  /** Model-facing status never embeds trajectories, graph bodies or previous tool results. */
  async status(session: SessionId, availableTools?: readonly string[]): Promise<Json> {
    const graph = this.graph.counts(), frontier = this.frontier.snapshot(), events = await this.trajectories.page(session);
    const identities = this.identities.list();
    const review = this.review.snapshot(session);
    return this.redactor.json({
      engagement: { id: this.engagement.engagement.id, name: this.engagement.engagement.name,
        objectives: this.engagement.engagement.objectives, scope: this.scope.scope },
      budget: this.engagement.snapshot(), policyVersion: this.policy(session).version,
      assessment: this.assessment.current(session) ? this.assessment.scorecard(this.assessment.current(session)!.id) : null,
      identities: { total: identities.length, items: identities.slice(0, 20) },
      graph,
      frontier: { queued: frontier.queued.length, visited: frontier.visited, discovered: frontier.discovered },
      trajectory: { sessionId: session, events: events.total, lastSeq: events.total ? events.total - 1 : null,
        inspectionTool: 'pentest_trajectory', fullView: 'Pentest → Trajectory' },
      review: { pending: review.pending.length, grants: review.grants.length },
      setup: { ...await this.toolSetup() }, plugins: this.inventory(),
      ...(availableTools ? { availableTools: [...availableTools].sort() } : {}),
    });
  }
  graphPage(offset = 0): Json {
    const page = this.graph.page(offset);
    return this.redactor.json({ ...page, nodes: page.nodes.map(node => ({ ...node, name: node.name.slice(0, 300),
      attributes: previewData(node.attributes).data })), edges: page.edges.map(edge => ({ ...edge, attributes: previewData(edge.attributes).data })) });
  }
  async snapshot(sessionId?: SessionId): Promise<Json> {
    const trajectory = sessionId ? await this.trajectories.page(sessionId) : { events: [], total: 0, nextBefore: null, file: '' };
    return this.redactor.json({ engagement: { ...this.engagement.engagement, scope: this.scope.scope }, budget: this.engagement.snapshot(),
      policy: this.currentPolicy, policyVersion: this.policy(sessionId ?? 'inspection' as SessionId).version,
      identities: this.identities.list(), graph: this.graphPage(), ranking: this.currentRanking,
      pluginConfig: this.currentPlugins, setup: { ...await this.toolSetup() }, telemetry: { ...(this.exporter ? await this.exporter.status() : { queued: 0, exhausted: 0 }), error: this.exportError ?? null },
      learning: this.currentPlugins.learning ? await this.learning().studies() : null,
      review: this.review.snapshot(sessionId), plugins: this.inventory(), sessions: await this.trajectories.sessions(),
      events: trajectory.events, trajectory: { total: trajectory.total, nextBefore: trajectory.nextBefore, file: trajectory.file }, schemaVersion: 2 });
  }
  async close(): Promise<void> {
    if (this.closing) return; this.closing = true; this.setupAbort.abort();
    for (const dispose of this.unsubscriptions) dispose();
    await this.metadataQueue; await this.settingsQueue;
    await this.review.close(); this.revision.abort(); await this.browserService?.close(); await this.reaService?.close();
    try { await this.trajectories.flush(); } finally { this.graph.close(); this.assessment.close(); await this.releaseWriter?.(); }
  }
}
