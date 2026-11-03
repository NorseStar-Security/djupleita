/** Cordis plugins for the DSH pentest distribution. */
import type { Context } from '@deepseek-ai/cordis';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm';
import type { ToolDefinition, ToolExecution, ToolExecutionToken, PostToolDecision } from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-user-approval';
import { prepareProfileAction, executeReconPlan, actionProfileBinding } from './action-profile.ts';
import type { ReviewOrigin } from './review.ts';
import type {} from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-api-session-controller';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type { JudgmentProvider, Json, IdentityId } from '@dsh-pentest/contracts';
import { canonical, digest, id as idForLearning, PentestError } from '@dsh-pentest/contracts';
import { SelectedModelJudge } from '@dsh-pentest/policy';
import { HttpInputSchema, classifyHttp, httpDestination, ModelFetchBroker } from '@dsh-pentest/http';
import type { HttpInput } from '@dsh-pentest/http';
import { z } from 'zod';
import { toolSchema } from './tool-schema.ts';
import { PentestRuntime } from './runtime.ts';
import type { EffectDescriptor, RuntimeConfig } from './runtime.ts';
import { DesktopChannel } from './rpc.ts';
import { inspectTrajectory, TrajectoryInputSchema } from './inspection.ts';
import { webFetch } from './web-fetch.ts';
import { BrowserInputSchema } from '@dsh-pentest/browser';
import { ReconRequestSchema, reconInputs, reconMode, PassiveInputSchema } from '@dsh-pentest/recon';
import { FuzzInputSchema } from '@dsh-pentest/fuzz';
import { RunInputSchema, studyReceipt } from '@dsh-pentest/learning';
import { reaEffects, ReaCatalogInputSchema } from '@dsh-pentest/rea';
import { AssessmentTools, ValidationTools } from './assessment.ts';
import { AssessmentSkills } from './skills.ts';
import pentestPreset from '../../../configs/pentest-preset.json' with { type: 'json' };
export { AssessmentTools, ValidationTools } from './assessment.ts';
export { AssessmentSkills } from './skills.ts';
export { PentestRuntime } from './runtime.ts';
export type { EffectDescriptor, RuntimeConfig } from './runtime.ts';

declare module '@deepseek-ai/cordis' { interface Context { pentest: PentestRuntime } }
export const inject = ['tools', 'llm'];
export const name = 'dsh-pentest';

export function modelJudge(ctx: Context): JudgmentProvider {
  return new SelectedModelJudge(async ({ model, system, state, signal }) => {
    const assembler = new BlockAssembler();
    const stream = ctx.llm.stream({ provider: model.provider, model: model.model, system,
      messages: [{ role: 'user', content: [{ type: 'text', text: canonical(state) }] }], tools: [], maxTokens: 1024, signal });
    let bytes = 0;
    for await (const chunk of stream) {
      if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
        throw new PentestError('JUDGE_TRANSPORT', `Risk judgment failed: ${chunk.reason.failure?.message ?? chunk.reason.kind}`);
      }
      if (chunk.type === 'text-delta') bytes += Buffer.byteLength(chunk.text);
      if (bytes > 65536) throw new PentestError('JUDGE_OUTPUT', 'Risk judgment exceeded its response limit');
      assembler.push(chunk);
    }
    const text = assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
    signal.throwIfAborted();
    if (!text.trim()) throw new PentestError('JUDGE_EMPTY', 'Risk judgment returned no text');
    return JSON.parse(text.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
  });
}

/** Monotonic guard prevents another pre-execute listener from skipping the policy. */
export const ToolPolicy = {
  name: 'pentest-tool-policy', inject: ['tools', 'pentest'],
  apply(ctx: Context): void {
    const accepted = new Map<ToolExecutionToken, { hash: string; policyVersion: string; origin: ReviewOrigin; profileBinding: string }>();
    let persistenceFailed = false;
    ctx.on('api-session/forked', async fork => {
      const lineage = { ...fork, sourceId: fork.sourceId as unknown as import('@dsh-pentest/contracts').SessionId,
        childId: fork.childId as unknown as import('@dsh-pentest/contracts').SessionId };
      ctx.pentest.assessment.recordFork(lineage);
      ctx.pentest.attach(lineage.childId);
      await ctx.pentest.trajectories.append(lineage.childId, 'harness/fork', lineage);
      await ctx.pentest.trajectories.flush();
    });
    ctx.on('session/event', (session, event) => {
      const sessionId = session.id as unknown as import('@dsh-pentest/contracts').SessionId;
      ctx.pentest.attach(sessionId);
      void ctx.pentest.trajectories.append(sessionId, 'harness/session-event', ctx.pentest.redactor.json(event))
        .catch(() => { persistenceFailed = true; });
    });
    ctx.on('session/flush', async () => {
      await ctx.pentest.trajectories.flush();
      if (persistenceFailed) throw new PentestError('TRAJECTORY_UNAVAILABLE', 'Chat trajectory persistence failed');
    });
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (persistenceFailed) return { kind: 'deny', reason: 'Pentest trajectory storage is unavailable' };
      try {
        const runtime = ctx.pentest;
        const origin = runtime.reviewOrigin(exec);
        const policy = runtime.policy(origin.sessionId);
        let profileBinding = '';
        await runtime.review.run(origin, async () => {
          const prepared = await prepareProfileAction(ctx, runtime, exec);
          const { action } = prepared;
          profileBinding = actionProfileBinding(prepared);
          await runtime.trajectories.flush();
          await policy.authorize({ action, signal: exec.signal }, runtime.approve);
        });
        accepted.set(exec.token, { hash: digest({ name: exec.name, arguments: exec.arguments }), policyVersion: policy.version, origin, profileBinding });
        return next();
      } catch (error) {
        return { kind: 'deny', reason: ctx.pentest.redactor.text(error instanceof Error ? error.message : 'Pentest policy failed') };
      }
    });
    ctx.on('tools/execute', async (exec, next) => {
      const binding = accepted.get(exec.token);
      return binding ? ctx.pentest.review.run(binding.origin, async () => {
        if (exec.name === 'web_fetch') return { isError: false as const, value: await webFetch(ctx.pentest, exec), content: [] };
        const prepared = await prepareProfileAction(ctx, ctx.pentest, exec);
        if (actionProfileBinding(prepared) !== binding.profileBinding) throw new PentestError('ACTION_CHANGED', 'Resolved destinations or workspace changed after policy authorization');
        if (prepared.recon) return { isError: false as const, value: await executeReconPlan(ctx.pentest, exec, prepared.recon), content: [] };
        return next();
      }) : next();
    });
    // Other harness plugins (sandbox, files, shell) use the same owner review surface.
    ctx.on('approval/request', async (request, next) => {
      const origin = ctx.pentest.review.current();
      if (!origin) return next();
      const allowed = await ctx.pentest.review.request('approval', { tool: request.toolName, reason: request.reason ?? '' },
        `Harness access: ${request.reason ?? 'This operation requires your approval'}. This access check is independent of a saved destination or action-effect allowance.`, request.signal ?? new AbortController().signal);
      return allowed ? 'allowed-once' : 'rejected';
    }, { prepend: true });
    ctx.tools.guard(exec => {
      if (persistenceFailed) return 'Pentest trajectory storage is unavailable';
      const binding = accepted.get(exec.token);
      if (!binding || binding.hash !== digest({ name: exec.name, arguments: exec.arguments })) return 'Pentest policy was not completed for this exact tool call';
      if (binding.policyVersion !== ctx.pentest.policy(ctx.pentest.session(exec)).version) return 'Pentest policy changed before tool dispatch';
      return undefined;
    });
    ctx.on('tools/post-execute', async (_exec, result, next): Promise<PostToolDecision> => {
      const subsequent = await next();
      if (subsequent.kind === 'block') return subsequent;
      if (result.isError) return { kind: 'accept', content: (subsequent.content ?? result.content).map(block => block.type === 'text'
        ? { ...block, text: ctx.pentest.redactor.text(block.text) } : block) };
      return { kind: 'accept', value: ctx.pentest.redactor.json(subsequent.value ?? result.value) };
    });
    ctx.on('tools/result', (exec, result) => {
      accepted.delete(exec.token);
      if (!exec.agent) return;
      const session = ctx.pentest.session(exec);
      void ctx.pentest.trajectories.append(session, 'harness/tool-result', ctx.pentest.redactor.json({
        callId: exec.callId, rootCallId: exec.rootCallId, name: exec.name, arguments: exec.arguments, result,
      })).catch(() => { persistenceFailed = true; });
      return undefined;
    });
    ctx.on('agent/pre-step', async (payload, next) => {
      ctx.pentest.attach(payload.agent.id as unknown as import('@dsh-pentest/contracts').SessionId, payload.modelSelection,
        payload.agent.session?.header.parentSession as unknown as import('@dsh-pentest/contracts').SessionId | undefined);
      return next();
    });
  },
};

function register(ctx: Context, definition: ToolDefinition, descriptor: EffectDescriptor): void {
  ctx.effect(() => ctx.pentest.registerDescriptor(definition.name, descriptor), `pentest: ${definition.name} effects`);
  ctx.tools.register(definition);
}
const output = { schema: { type: 'object', properties: {}, additionalProperties: true } as const,
  render: (_args: unknown, value: Json) => [{ type: 'text' as const, text: canonical(value) }] };
const readDescriptor = (plugin: string): EffectDescriptor => ({ plugin, confinement: 'local-read',
  describe: () => ({ destinations: [], effects: ['read'], reversible: true }) });

/** Describe local Harness controls; child tools still cross the same global execution policy. */
export const HarnessControlEffects = {
  name: 'pentest-harness-controls', inject: ['pentest'], apply(ctx: Context): void {
    for (const tool of ['get_goal', 'list_agents', 'list_subagent_models', 'ask_user_question',
      'read', 'read_image', 'glob', 'grep', 'skill', 'job_list', 'job_output', 'schedule_list', 'current_time']) {
      ctx.effect(() => ctx.pentest.registerDescriptor(tool, readDescriptor('harness-control')), `pentest: ${tool} effects`);
    }
    ctx.effect(() => ctx.pentest.registerDescriptor('working_directory', { plugin: 'harness-control', confinement: 'local-read',
      describe(args) {
        const input = z.object({ cd: z.string().optional() }).strict().parse(args);
        return { destinations: [], effects: [input.cd === undefined ? 'read' : 'modify'], reversible: true };
      } }), 'pentest: working directory effects');
    for (const tool of ['write', 'edit']) {
      ctx.effect(() => ctx.pentest.registerDescriptor(tool, { plugin: 'harness-filesystem', confinement: 'transport',
        describe: () => ({ destinations: [], effects: ['overwrite'], reversible: false }) }), `pentest: ${tool} effects`);
    }
    for (const tool of ['bash', 'run_code', 'web_search', 'cordis']) {
      ctx.effect(() => ctx.pentest.registerDescriptor(tool, { plugin: 'harness-execution', confinement: 'transport',
        describe: () => ({ destinations: [], effects: ['unknown'], reversible: false }) }), `pentest: ${tool} effects`);
    }
    for (const tool of ['load_workspace_dependencies', 'todo_write', 'schedule_create', 'schedule_update', 'present', 'job_kill']) {
      ctx.effect(() => ctx.pentest.registerDescriptor(tool, { plugin: 'harness-control', confinement: 'transport',
        describe: () => ({ destinations: [], effects: ['modify'], reversible: true }) }), `pentest: ${tool} effects`);
    }
    ctx.effect(() => ctx.pentest.registerDescriptor('schedule_delete', { plugin: 'harness-control', confinement: 'transport',
      describe: () => ({ destinations: [], effects: ['delete'], reversible: false }) }), 'pentest: schedule delete effects');
    ctx.effect(() => ctx.pentest.registerDescriptor('web_fetch', { plugin: 'harness-web', confinement: 'transport',
      describe(args) { const input = z.object({ url: z.url() }).passthrough().parse(args);
        return { destinations: [httpDestination({ url: input.url, method: 'GET', headers: {} })], ...classifyHttp({ url: input.url, method: 'GET', headers: {} }) }; }
    }), 'pentest: web fetch effects');
    for (const tool of ['create_goal', 'update_goal', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent']) {
      ctx.effect(() => ctx.pentest.registerDescriptor(tool, { plugin: 'harness-control', confinement: 'transport',
        describe: () => ({ destinations: [], effects: ['modify'], reversible: true }) }), `pentest: ${tool} effects`);
    }
  },
};

export const HttpTools = {
  name: 'pentest-http', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    register(ctx, { name: 'pentest_http', description: 'Send a bounded HTTP request. Ordinary reads may research unlisted, non-excluded sites; writes and destructive requests require target scope. Use identityId for credentials. Every redirect and connection is checked.',
      parameters: toolSchema(HttpInputSchema), output,
      async execute(args, exec) {
        const input = HttpInputSchema.parse(args) as HttpInput;
        const session = ctx.pentest.session(exec);
        return ctx.pentest.redactor.json(await ctx.pentest.http(session).request(input, session, exec.signal,
          ctx.pentest.approve));
      } }, { plugin: 'http', confinement: 'brokered', describe(args) {
        const input = HttpInputSchema.parse(args) as HttpInput;
        return { destinations: [httpDestination(input)], ...classifyHttp(input), ...(input.identityId ? { identityId: input.identityId } : {}) };
      } });
  },
};
export const InspectionTools = {
  name: 'pentest-inspection', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    register(ctx, { name: 'pentest_status', description: 'Read a concise engagement summary: scope, budgets, identity references, tool readiness and graph/trajectory counts. availableTools lists the complete callable catalog for this agent, including Harness subagent and goal tools; plugins lists only pentest effect adapters. Full logs and graph bodies are not included.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute(_args, exec) { return ctx.pentest.status(ctx.pentest.session(exec),
        ctx.tools.definitions(exec.agent, exec.toolSet).map(tool => tool.name)); } }, readDescriptor('inspection'));
  },
};
export const GraphTools = {
  name: 'pentest-graph', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    register(ctx, { name: 'pentest_graph_export', description: 'Export the evidence graph as RAGE 0.1 NDJSON.',
      parameters: { type: 'object', properties: {}, additionalProperties: false }, output,
      async execute() { return { format: 'rage/0.1', ndjson: ctx.pentest.graph.exportRage() }; } }, readDescriptor('graph'));
    const schema = z.object({ source: z.string(), target: z.string(), maxDepth: z.number().int().min(1).max(16).default(6), includeInferred: z.boolean().default(false) });
    register(ctx, { name: 'pentest_graph_paths', description: 'Query evidence-backed paths. Inferred relationships are excluded unless explicitly requested; discovery-only edges are never treated as access capabilities.',
      parameters: toolSchema(schema), output, async execute(args) {
        const input = schema.parse(args); return { paths: ctx.pentest.graph.paths(input.source, input.target, input.maxDepth, input.includeInferred) };
      } }, readDescriptor('graph'));
  },
};
export const CrawlTools = {
  name: 'pentest-crawl', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    const schema = z.object({ seeds: z.array(z.url()).min(1).max(100) });
    register(ctx, { name: 'pentest_crawl', description: 'Crawl scoped seeds within shared budgets; prioritize new endpoints and stop when coverage saturates.',
      parameters: toolSchema(schema), output,
      async execute(args, exec) {
        const input = schema.parse(args), session = ctx.pentest.session(exec), crawler = ctx.pentest.crawl(session);
        crawler.observe(input.seeds, 'seed');
        return ctx.pentest.redactor.json(await crawler.run(session, exec.signal));
      } }, { plugin: 'crawl', confinement: 'brokered', describe(args) { return {
        destinations: schema.parse(args).seeds.map(url => ({ url, purpose: 'target' as const })), effects: ['read'], reversible: true };
      } });
  },
};
export const AuthzTools = {
  name: 'pentest-authz', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    const compareSchema = z.object({ request: HttpInputSchema, identityA: z.string().uuid(), identityB: z.string().uuid(), anonymous: z.boolean().default(true) });
    register(ctx, { name: 'pentest_authz_compare', description: 'Replay a read request with identity A, identity B and optionally anonymous; retain evidence and mark unverified matches as candidates.',
      parameters: toolSchema(compareSchema), output,
      async execute(args, exec) {
        const input = compareSchema.parse(args) as import('@dsh-pentest/authz').ComparisonInput;
        const session = ctx.pentest.session(exec);
        return ctx.pentest.redactor.json(await ctx.pentest.authz(session).compare(input, session, exec.signal));
      } }, { plugin: 'authz', confinement: 'brokered', describe(args) { const input = compareSchema.parse(args); return {
        destinations: [{ url: input.request.url, purpose: 'target' }], effects: ['read'], reversible: true };
      } });
  },
};

export const BrowserTools = {
  name: 'pentest-browser', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    const schema = z.object({ action: BrowserInputSchema, identityId: z.string().uuid().optional() });
    register(ctx, { name: 'pentest_browser', description: 'Use an isolated Playwright browser for a chat and identity reference. Every HTTP request uses the scope and credential broker. No arbitrary JavaScript.',
      parameters: toolSchema(schema), output, async execute(args, exec) {
        const input = schema.parse(args), session = ctx.pentest.session(exec);
        const result = await ctx.pentest.browser().execute(input.action, session, input.identityId as IdentityId | undefined,
          exec.signal, ctx.pentest.approve);
        await ctx.pentest.assessment.browserObservation(session, input.identityId as IdentityId | undefined, result);
        return result;
      } }, { plugin: 'browser', confinement: 'brokered', describe(args) {
        const { action } = schema.parse(args);
        if (action.operation === 'fill' && action.value) ctx.pentest.redactor.register(action.value);
        return { destinations: action.operation === 'navigate' ? [httpDestination({ url: action.url, method: 'GET', headers: {} })] : [],
          effects: action.operation === 'navigate' || action.operation === 'snapshot' ? ['read']
            : action.operation === 'fill' ? ['modify'] : ['unknown'],
          reversible: action.operation !== 'click' };
      } });
  },
};
export const ReconTools = {
  name: 'pentest-recon', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    register(ctx, { name: 'pentest_intelligence', description: 'Public credential-free DNS records, or optional credential-backed PDCP/Chaos data. Inspect pentest_status intelligence availability before optional sources. Results and provenance are saved automatically without expanding target scope.',
      parameters: toolSchema(PassiveInputSchema), output, async execute(args, exec) {
        return ctx.pentest.intelligence().run(PassiveInputSchema.parse(args), ctx.pentest.session(exec), ctx.pentest.signal(exec.signal));
      } }, { plugin: 'passive-intelligence', confinement: 'brokered', describe(args) {
        const input = PassiveInputSchema.parse(args);
        let scoped = true;
        try { ctx.pentest.intelligence().check(input.domain); } catch (error) { if (!(error instanceof PentestError) || error.code !== 'OUT_OF_SCOPE') throw error; scoped = false; }
        return { destinations: scoped ? [] : [{ url: `https://${input.domain}/`, purpose: 'target', access: 'read' }], effects: ['read'], reversible: true, activity: 'research' }; } });
    register(ctx, { name: 'pentest_recon_doctor', description: 'Inspect configured ProjectDiscovery executables and verify their pinned checksums.',
      parameters: { type: 'object', additionalProperties: false }, output, async execute() { return ctx.pentest.recon().doctor(); } }, readDescriptor('recon'));
    register(ctx, { name: 'pentest_recon', description: 'Run pinned ProjectDiscovery tools: passive subfinder/asnmap/uncover or active httpx/katana. Use target for ONE domain/URL; use targets (URL array) for an httpx batch with shared rate and concurrency limits. Evidence is saved automatically; no target-list or note file is needed.',
      parameters: toolSchema(ReconRequestSchema), output, async execute(args, exec) {
        const inputs = reconInputs(args), session = ctx.pentest.session(exec), recon = ctx.pentest.recon(), signal = ctx.pentest.signal(exec.signal);
        return inputs.length > 1 ? recon.runBatch(inputs, session, signal) : recon.run(inputs[0]!, session, signal);
      } }, { plugin: 'recon', confinement: 'transport', describe(args) {
        const inputs = reconInputs(args), passive = reconMode(inputs[0]!.tool) === 'passive';
        let scoped = passive;
        if (scoped) try { for (const input of inputs) ctx.pentest.recon().check(input); } catch (error) { if (!(error instanceof PentestError) || error.code !== 'OUT_OF_SCOPE') throw error; scoped = false; }
        return { destinations: scoped ? [] : inputs.map(input => ({ url: passive ? `https://${input.target}/` : input.target, purpose: 'target' as const })), effects: ['read'], reversible: true, activity: passive ? 'research' : 'recon' };
      } });
  },
};
export const FuzzTools = {
  name: 'pentest-ffuf', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    register(ctx, { name: 'pentest_ffuf_doctor', description: 'Verify the pinned ffuf executable and list configured wordlist IDs.',
      parameters: { type: 'object', additionalProperties: false }, output, async execute() { return ctx.pentest.fuzz().doctor(); } }, readDescriptor('ffuf'));
    register(ctx, { name: 'pentest_ffuf', description: 'Fuzz FUZZ in an HTTP(S) URL path or query on a fixed host using ffuf. Supply words or a configured wordlistId (common is built in). Supports status/size/word/line filters and identityId. Every request is individually scoped, effect-reviewed and budgeted; matches feed the evidence graph and crawl frontier. Redirects are not followed.',
      parameters: toolSchema(FuzzInputSchema), output, async execute(args, exec) {
        return ctx.pentest.fuzz().run(FuzzInputSchema.parse(args), ctx.pentest.session(exec), ctx.pentest.signal(exec.signal));
      } }, { plugin: 'ffuf', confinement: 'brokered', describe(args) {
        const input = FuzzInputSchema.parse(args);
        return { destinations: [], ...classifyHttp({ url: input.url, method: input.method, headers: input.headers,
          ...(input.body === undefined ? {} : { body: input.body }) }), ...(input.identityId ? { identityId: input.identityId as IdentityId } : {}) };
      } });
  },
};
export const ReaTools = {
  name: 'pentest-rea', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    register(ctx, { name: 'pentest_rea_doctor', description: 'Check REA Node compatibility, selected analysis roots and native Ghidra/JDK health. artifactInventoryReady is independent of native decompilation. Unselected engines and external CLI skill registration are informational; this embedded integration does not require rea setup.',
      parameters: { type: 'object', additionalProperties: false }, output, async execute(_args, exec) { return ctx.pentest.rea().doctor(ctx.pentest.signal(exec.signal)); } }, readDescriptor('rea'));
    register(ctx, { name: 'pentest_rea_catalog', description: 'Search advertised REA tools using query and pages; request tool by exact name for its inputSchema. Large schemas can be narrowed with schemaPath. Read the schema before invoking; never guess names. Archive/DMG inventory uses open_binary then inspect_artifact and does not require Ghidra.',
      parameters: toolSchema(ReaCatalogInputSchema), output, async execute(args, exec) { return ctx.pentest.rea().discover(args, ctx.pentest.signal(exec.signal)); } }, readDescriptor('rea'));
    const schema = z.object({ tool: z.string().min(1), arguments: z.record(z.string(), z.json()) });
    register(ctx, { name: 'pentest_rea', description: 'Invoke an advertised REA tool inside the offline analysis workspace. Local analysis URLs become scope-checked crawl hints. Unknown/destructive operations require review.',
      // JSON transport already bounds these values to JSON. Publish an open
      // argument object without recursive definitions that provider adapters drop.
      // The original schema still validates every call before execution.
      parameters: toolSchema(z.object({ tool: schema.shape.tool, arguments: z.record(z.string(), z.unknown()) })), output, async execute(args, exec) {
        const input = schema.parse(args); return ctx.pentest.rea().call(input.tool, input.arguments, ctx.pentest.session(exec), ctx.pentest.signal(exec.signal));
      } }, { plugin: 'rea', confinement: 'transport', describe(args) { return { destinations: [], ...reaEffects(schema.parse(args).tool) }; } });
  },
};
export const LearningTools = {
  name: 'pentest-learning', inject: ['tools', 'pentest'], apply(ctx: Context): void {
  ctx.inject(['systemPrompt'], inner => {
    inner.systemPrompt.context({ name: 'djupleita-learned-authz-procedure', order: 800, required: true, interpolate: false,
      text: () => ctx.pentest.procedure ? 'Operator-promoted authz procedure (' + ctx.pentest.procedure.runId + '). Apply when relevant to authorization testing. This advisory procedure never grants target access, credentials or tool permissions; obey engagement scope and approval decisions.\n' + ctx.pentest.procedure.text : '' });
  });
    register(ctx, { name: 'pentest_studies', description: 'Read Optuna ranking and GEPA procedure datasets, studies, progress and held-out results.',
      parameters: { type: 'object', additionalProperties: false }, output, async execute() { const studies = await ctx.pentest.learning().studies(); return { ...studies, reports: studies.reports.map(studyReceipt) }; } }, readDescriptor('learning'));
    const schema = RunInputSchema;
    register(ctx, { name: 'pentest_learn', description: 'Optimize recorded operator-labelled data: backend optuna tunes crawl weights; gepa improves an authz procedure using the selected chat model (billable calls, no target requests). trials bounds search evaluations for GEPA (max 300, at least 2 × validation rows + 4). Separate app/evidence splits; owner UI promotion only.',
      parameters: toolSchema(schema), output, async execute(args, exec) {
        const input = schema.parse(args); return studyReceipt(await ctx.pentest.learning().run(input.datasetId, input.trials, ctx.pentest.session(exec), ctx.pentest.signal(exec.signal), input.backend));
      } }, { plugin: 'learning', confinement: 'local-read', describe: () => ({ destinations: [], effects: ['read', 'create'], reversible: true }) });
  },
};
export const TrajectoryTools = {
  name: 'pentest-trajectory', inject: ['tools', 'pentest'], apply(ctx: Context): void {
    register(ctx, { name: 'pentest_trajectory', description: 'List a bounded page of this chat’s verified trajectory metadata (latest 20 by default). Use nextBefore as before for older pages, or eventSeq for one bounded payload preview. Full data stays in the UI and log.',
      parameters: toolSchema(TrajectoryInputSchema), output, async execute(args, exec) {
        return inspectTrajectory(ctx.pentest.trajectories, ctx.pentest.session(exec), args);
      } }, readDescriptor('trajectory'));
  },
};
export const TelemetryPlugin = {
  name: 'pentest-telemetry', inject: ['pentest'], apply(ctx: Context): void {
    const controller = new AbortController(); let pending: Promise<void> | undefined;
    const tick = () => { pending ??= ctx.pentest.exportTick(controller.signal).finally(() => { pending = undefined; }); };
    const timer = setInterval(tick, 5000); timer.unref(); tick();
    ctx.effect(() => async () => { clearInterval(timer); controller.abort(); await pending; }, 'pentest: OTLP export');
  },
};

export const ModelEgressPlugin = {
  name: 'pentest-model-egress', inject: ['pentest', 'llm'], apply(ctx: Context): void {
    const broker = new ModelFetchBroker(ctx.pentest.redactor);
    ctx.effect(() => broker.install(), 'pentest: model fetch transport');
    async function* stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>, endpoints?: readonly string[], meter = false): AsyncIterable<StreamChunk> {
      const runtime = ctx.pentest, scope = runtime.scope;
      const providerScope = endpoints?.length ? scope.forModelEndpoints(endpoints) : undefined;
      const signal = runtime.signal(options.signal ?? new AbortController().signal);
      const agent = ctx.get('agents')?.currentInitiator();
      const current = runtime.review.current();
      const origin = current || agent ? { sessionId: current?.sessionId ?? agent!.id as unknown as import('@dsh-pentest/contracts').SessionId,
        tool: 'model_request', argumentsHash: digest({ provider: options.provider, model: options.model }),
        ...(current?.callId ? { callId: current.callId } : {}),
        arguments: { provider: options.provider, model: options.model }, grants: new Set<string>() } : undefined;
      const run = <T,>(operation: () => T): T => origin
        ? runtime.review.run(origin, () => broker.run(scope, signal, operation, providerScope)) : broker.run(scope, signal, operation, providerScope);
      const iterator = run(() => next()[Symbol.asyncIterator]());
      let tokens: number | undefined;
      try {
        while (true) {
          const step = await run(() => iterator.next());
          if (step.done) return;
          if (step.value.type === 'usage') {
            const usage = step.value.usage;
            tokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
          }
          yield step.value;
        }
      } finally {
        try { await run(() => iterator.return?.()); }
        finally { if (meter && origin) runtime.assessment.recordUsage(origin.sessionId, tokens); }
      }
    }
    // Preparation retains the fallback boundary; dispatch adds only the API roots
    // captured by the registered adapter, including custom provider URLs.
    ctx.on('llm/stream', (options, next) => stream(options, next));
    ctx.on('llm/dispatch', (options, transport, next) => stream(options, next, transport?.endpoints, true));
  },
};

/** Mandatory engagement services and enforcement; optional tools mount through managed bundles. */
export async function applyCore(ctx: Context, config: RuntimeConfig, internals: { judge?: JudgmentProvider } = {}): Promise<void> {
  const runtime = await PentestRuntime.open(config, internals.judge ?? modelJudge(ctx));
  ctx.effect(() => () => runtime.close(), 'pentest: durable stores');
  ctx.provide('pentest', runtime);
  ctx.inject(['systemPrompt'], inner => {
    const persona = pentestPreset.plugins.find(plugin => plugin.id === 'persona')?.config;
    inner.systemPrompt.context({ name: 'djupleita-persona', order: 780, required: true, interpolate: false,
      text: persona && 'prefix' in persona ? persona.prefix : '' });
    inner.systemPrompt.context({ name: 'djupleita-target-scope', order: 790, required: true, interpolate: false,
      text: () => runtime.scope.instructions() });
    inner.systemPrompt.context({ name: 'djupleita-action-profile', order: 791, required: true, interpolate: false,
      text: () => runtime.policyProfile === 'red-team'
        ? 'Red team action profile: pursue the operator-requested assessment through managed tools, including bounded active analysis. Routine research, managed reconnaissance and workspace changes follow the configured policy; unknown effects go to an isolated LLM risk judge by default. Use pentest_recon for subfinder/httpx. Let the installed controls evaluate operations and respond to concrete tool decisions. Scope and destructive-action reviews remain authoritative; use managed tools for network traffic because arbitrary shell destinations are not broker-verified.'
        : 'Review action profile: pursue the operator-requested assessment through managed tools. Unknown or destructive operations can require owner review; surface a review when the tool requests it. Target scope is enforced independently.' });
  });
  ctx.inject(['agents'], inner => { runtime.setLearningSelection(session => inner.agents.get(session as unknown as import('@deepseek-ai/dsh-session').SessionId)?.model.current() ?? runtime.model(session)); });
  runtime.setLearningModel(async (session, request, signal, route) => {
    const assembler = new BlockAssembler();
    let size = 0;
    const origin = runtime.review.current() ?? { sessionId: session, tool: 'pentest_learn', callId: idForLearning(), argumentsHash: digest(request), arguments: runtime.redactor.json({ purpose: request.purpose }), grants: new Set<string>() };
    return runtime.review.run(origin, async () => {
      for await (const chunk of ctx.llm.stream({ ...route, system: request.system, messages: [{ role: 'user', content: [{ type: 'text', text: request.prompt }] }], tools: [], maxTokens: 4096, signal })) {
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') size += Buffer.byteLength(chunk.text);
        if (size > 32768) throw new PentestError('LEARNING_OUTPUT', 'Learning model response exceeds 32 KiB');
        assembler.push(chunk);
      }
      return assembler.blocks().filter(block => block.type === 'text').map(block => block.text).join('');
    });
  });

  // A provided service becomes available after this parent activates. Its children
  // must mount through Cordis dependency scheduling, rather than being awaited here.
  ctx.plugin(ToolPolicy);
  ctx.plugin(HarnessControlEffects);
  ctx.plugin(InspectionTools);
  ctx.plugin(ModelEgressPlugin);
  ctx.inject(['connection'], (inner) => { inner.plugin(DesktopChannel); });
}

/** Complete in-process composition retained for embedders and integration fixtures. */
export async function apply(ctx: Context, config: RuntimeConfig, internals: { judge?: JudgmentProvider } = {}): Promise<void> {
  await applyCore(ctx, config, internals);
  ctx.plugin(HttpTools);
  ctx.plugin(GraphTools);
  ctx.plugin(CrawlTools);
  ctx.plugin(AuthzTools);
  ctx.plugin(BrowserTools);
  ctx.plugin(ReconTools);
  ctx.plugin(FuzzTools);
  ctx.plugin(ReaTools);
  ctx.plugin(LearningTools);
  ctx.plugin(TrajectoryTools);
  ctx.plugin(TelemetryPlugin);
  ctx.plugin(AssessmentTools);
  ctx.plugin(AssessmentSkills);
  ctx.plugin(ValidationTools);
}
