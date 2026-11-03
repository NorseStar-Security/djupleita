/** Browser acceptance through the authenticated production web app in a private home. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const log = console.log;
console.log = (...args) => { if (!String(args[0]).startsWith('dsh web:')) log(...args); };
const root = await mkdtemp(join(tmpdir(), 'djupleita-modes-'));
process.env.DSH_HOME = join(root, 'home');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= process.platform === 'darwin' ? join(process.env.HOME, 'Library/Caches/ms-playwright') : join(process.env.HOME, '.cache/ms-playwright');
process.env.HOME = join(root, 'os-home');
process.env.DSH_PENTEST_ENGAGEMENT = join(root, 'engagement.json');
await mkdir(process.env.HOME, { recursive: true });
const { prepareProfile } = await import('../../scripts/profile.mjs');
const profile = join(process.env.DSH_HOME, 'profiles/pentest');
const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
let ctx;
try {
  const courseScope = JSON.parse(await readFile(resolve('configs/scope.example.json'), 'utf8'));
  const suffix = courseScope.targets[0].host.split('.').slice(-2).join('.');
  const example = JSON.parse(JSON.stringify(courseScope).replaceAll(suffix, 'example.test'));
  const template = JSON.parse(await readFile(resolve('configs/engagement.example.json'), 'utf8'));
  template.scope = { targets: [], exclusions: [], networks: [], services: example.services };
  await writeFile(process.env.DSH_PENTEST_ENGAGEMENT, JSON.stringify(template));
  const prepared = await prepareProfile(profile);
  assert.deepEqual(prepared.engagement.scope, courseScope, 'Legacy blank defaults must be saved before boot');
  const path = join(profile, 'cordis.patch.yml');
  // Preserve executable platform expressions through a document edit.
  const doc = require('yaml').parseDocument(await readFile(path, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  for (const row of doc.contents.items) for (const entry of row.get('insert')?.items ?? []) {
    if (entry.get('id') === 'pentest') {
      entry.get('config').get('engagement').set('scope', example);
      entry.get('config').get('engagement').set('model', { provider: 'red-team-fixture', model: 'offline-judge' });
      entry.get('config').set('root', join(root, 'engagements'));
      entry.get('config').set('plugins', {});
      entry.get('config').set('keychainHelper', '/unused-fixture-helper');
    }
  }
  await writeFile(path, doc.toString({ lineWidth: 0 }));
  const { AssessmentService } = await import('../../packages/assessment/lib/index.js');
  const savedRoot = join(root, 'engagements', prepared.engagement.id);
  await mkdir(savedRoot, { recursive: true });
  const savedBudget = new AssessmentService(join(savedRoot, 'assessment.sqlite'), {});
  savedBudget.saveBudget({ requests: 3, startedAt: Date.now() - prepared.engagement.budget.durationMs - 1000 });
  savedBudget.close();
  const { bootProductionProfile } = await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const { provideCmdline } = await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  ctx = await bootProductionProfile({ binName: 'djupleita-fixture', profile: 'pentest', overlayPaths: [path], prepare(inner) {
    provideCmdline(inner, { args: ['--no-open', '--host', '127.0.0.1', '--port', '0'], exit() {}, ready: { onReady(listener) { queueMicrotask(listener); return () => {}; } } });
  } });
  let judgments = 0;
  const { LlmAdapter } = await import('../../vendor/deepseek-harness/packages/llm/llm/lib/index.js');
  class OfflineJudge extends LlmAdapter {
    async *stream() {
      judgments++;
      const text = JSON.stringify({ deletion: 0, irreversible: 0, disruption: 0, confidence: 0.55, reason: 'Synthetic local fixture operation' });
      yield { type: 'block-start', index: 0, blockType: 'text' }; yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }; yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['red-team-fixture'], new OfflineJudge());
  const { chromium } = await import('../../packages/browser/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const anonymous = await page.request.get(ctx.webServer.getOrigin());
    assert.equal(anonymous.status(), 401, 'Web startup must require authentication');
    await page.goto(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
    await page.getByRole('dialog', { name: 'Preview Notice' }).getByRole('button', { name: 'Continue', exact: true }).click();
    const poll = async predicate => {
      for (let i = 0; i < 100; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
      throw new Error('Web fixture state did not settle');
    };
    const plugins = async () => {
      await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
      const back = page.getByRole('button', {name:'Back to plugins', exact:true});
      if (await back.count()) await back.click();
    };
    const policy = async () => {
      await plugins();
      await page.getByText('Djupleita · Engagement and identities', { exact: true }).click();
      await page.locator('textarea[name="scope"]').waitFor();
    };
    await policy();
    await page.getByText('Time budget expired. Network tools cannot run until you renew it.', { exact: true }).waitFor();
    const usedBefore = ctx.pentest.engagement.snapshot().requests;
    await page.getByRole('button', { name: 'Renew time budget', exact: true }).click();
    await poll(() => !ctx.pentest.engagement.snapshot().timeExhausted);
    assert.equal(ctx.pentest.engagement.snapshot().requests, usedBefore);
    await page.reload(); await policy();
    await page.getByText('Time remaining:', { exact: false }).waitFor();
    const editor = page.locator('textarea[name="scope"]');
    const readScope = async () => JSON.parse((await editor.inputValue()).replaceAll(suffix, 'example.test'));
    assert.deepEqual(await readScope(), example);
    await page.getByText('Saved scope available to the agent: 3 target rules.', { exact: false }).waitFor();
    const status = await ctx.pentest.status('web-fixture');
    assert.deepEqual(status.engagement.scope, example);
    for (const target of example.targets) assert(ctx.pentest.scope.instructions().includes(target.host));
    const toggle = page.getByRole('switch', { name: 'Scope management', exact: true });
    assert.equal(await toggle.isChecked(), false);
    assert.equal(ctx.pentest.scope.enabled, false, 'Fresh course scope management starts off');
    assert.doesNotThrow(() => ctx.pentest.scope.check({ url: 'https://mail.prod.example.test/', purpose: 'target' }));
    await toggle.check();
    assert.equal(ctx.pentest.scope.enabled, false, 'Switch changes remain a draft until Apply');
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => ctx.pentest.scope.enabled);
    for (const access of ['read', 'active']) {
      assert.throws(() => ctx.pentest.scope.check({ url: 'https://mail.prod.example.test/', purpose: 'target', access }), /Excluded/);
      assert.doesNotThrow(() => ctx.pentest.scope.check({ url: 'https://www.prod.example.test/', purpose: 'target', access }));
    }
    assert.throws(() => ctx.pentest.scope.check({ url: 'https://www.prod.example.test:8443/', purpose: 'target' }), /Excluded/);
    await page.getByText('Exact targets override wildcard exclusions', { exact: false }).first().waitFor();
    assert.doesNotThrow(() => ctx.pentest.scope.check({ url: 'https://research.example.test/blog', purpose: 'target', access: 'read' }));
    assert.throws(() => ctx.pentest.scope.check({ url: 'https://research.example.test/blog', purpose: 'target', access: 'active' }), /outside/);
    await page.getByText('Ordinary web reads and passive research may use unlisted sites', { exact: false }).first().waitFor();
    for (const host of ['www.prod.example.test', 'app.dev.example.test', 'app.test.example.test']) {
      assert.doesNotThrow(() => ctx.pentest.scope.check({ url: `https://${host}/`, purpose: 'target' }));
    }
    await page.reload(); await policy();
    assert.equal(await toggle.isChecked(), true, 'Enabled setting survives browser reload');
    await toggle.uncheck();
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => !ctx.pentest.scope.enabled);
    await page.reload(); await policy();
    assert.equal(await toggle.isChecked(), false);
    const services = { ...example.services, model: [{ host: 'model.example.test', schemes: ['https'], ports: [443], pathPrefixes: ['/v1'], allowPrivateAddresses: false }] };
    await ctx.pentest.updateSettings({ enabled: false, targets: [], exclusions: [], networks: [], services }, (await ctx.pentest.snapshot()).policy, 'web-fixture');
    await page.reload(); await policy();
    const configuredDraft = { ...example, services };
    assert.deepEqual(await readScope(), { ...configuredDraft, targets: [], exclusions: [] }, 'An explicitly saved empty scope must stay empty in the editor');
    await page.getByText('Saved scope available to the agent: 0 target rules.', { exact: false }).waitFor();
    await editor.fill('');
    await page.getByRole('button', { name: 'Insert course scope', exact: true }).click();
    assert.deepEqual(await readScope(), configuredDraft, 'A blank editor can restore the example with its saved services');
    await page.getByText('Unapplied draft changes.', { exact: false }).waitFor();
    const customDraft = { ...configuredDraft, targets: [], exclusions: ['custom.example.test'], networks: ['192.0.2.0/24'] };
    await editor.fill(JSON.stringify(customDraft));
    await page.getByRole('button', { name: 'Insert course scope', exact: true }).click();
    assert.deepEqual(await readScope(), { ...customDraft, targets: example.targets, exclusions: [...example.exclusions, ...customDraft.exclusions] }, 'Inserting course scope adds the production exclusion and preserves custom boundaries');
    await page.getByRole('button', { name: 'Insert course scope', exact: true }).click();
    assert.deepEqual((await readScope()).exclusions, [...example.exclusions, ...customDraft.exclusions], 'Repeated insertion does not duplicate exclusions');
    assert.equal(ctx.pentest.scope.scope.targets.length, 0, 'Prefill and restore must remain inactive');
    await editor.fill(JSON.stringify(customDraft));
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => ctx.pentest.scope.scope.exclusions.includes('custom.example.test'));
    assert.equal(ctx.pentest.scope.enabled, false);
    for (const access of ['read', 'active']) assert.doesNotThrow(() => ctx.pentest.scope.check({ url: 'https://custom.example.test/', purpose: 'target', access }));
    await toggle.check();
    await editor.fill(JSON.stringify({ ...customDraft, enabled: true }));
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => ctx.pentest.scope.enabled);
    assert.throws(() => ctx.pentest.scope.check({ url: 'https://custom.example.test/', purpose: 'target', access: 'read' }), /Excluded/);
    await toggle.uncheck();
    await editor.fill(JSON.stringify(customDraft));
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => !ctx.pentest.scope.enabled);
    await page.reload(); await policy();
    assert.equal(await toggle.isChecked(), false);
    assert.doesNotThrow(() => ctx.pentest.scope.check({ url: 'https://custom.example.test/', purpose: 'target', access: 'active' }));
    assert.doesNotThrow(() => ctx.pentest.scope.check({ url: 'https://research.example.test/blog', purpose: 'target', access: 'read' }));
    const actionProfile = page.getByRole('combobox', { name: 'Action profile', exact: true });
    assert.equal(await actionProfile.inputValue(), 'review');
    await actionProfile.selectOption('red-team');
    assert.equal(ctx.pentest.policyProfile, 'review', 'Profile selection remains a draft until Apply');
    assert.equal(await page.getByRole('combobox', { name: 'Unknown effects', exact: true }).inputValue(), 'judge');
    await page.getByRole('combobox', { name: 'Destructive actions', exact: true }).selectOption('deny');
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => ctx.pentest.policyProfile === 'red-team');
    await page.reload(); await policy();
    assert.equal(await actionProfile.inputValue(), 'red-team');
    assert.equal(await page.getByRole('combobox', { name: 'Destructive actions', exact: true }).inputValue(), 'deny');
    const { id: actionId } = await import('../../packages/contracts/lib/index.js');
    const opaque = { id: actionId(), engagementId: ctx.pentest.engagement.engagement.id, sessionId: 'web-fixture', tool: 'bash', plugin: 'harness-execution', arguments: { command: 'printf synthetic-fixture' }, destinations: [], effects: ['unknown'], reversible: false };
    assert.equal((await ctx.pentest.policy('web-fixture').authorize({ action: opaque, signal: AbortSignal.timeout(5000) })).kind, 'allow');
    assert.equal(judgments, 1, 'Unknown effects must reach the isolated offline judge');
    await assert.rejects(() => ctx.pentest.policy('web-fixture').authorize({ action: { ...opaque, effects: ['delete'] }, signal: AbortSignal.timeout(5000) }), /requires your decision/);
    assert.equal(judgments, 1, 'Known destructive effects must not reach the judge');
    const unknownEffects = page.getByRole('combobox', { name: 'Unknown effects', exact: true });
    await unknownEffects.selectOption('allow');
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => ctx.pentest.policyConfig.redTeam?.unknown === 'allow');
    await page.reload(); await policy();
    assert.equal(await unknownEffects.inputValue(), 'allow', 'Unknown Allow must survive reload');
    await page.getByText('Unknown effects: Allow skips effect judgment', { exact: false }).waitFor();
    assert.equal((await ctx.pentest.policy('web-fixture').authorize({ action: { ...opaque, id: actionId() }, signal: AbortSignal.timeout(5000) })).kind, 'allow');
    await assert.rejects(() => ctx.pentest.policy('web-fixture').authorize({ action: { ...opaque, id: actionId(), effects: ['unknown', 'delete'] }, signal: AbortSignal.timeout(5000) }), /requires your decision/);
    assert.equal(judgments, 1, 'Explicit unknown Allow must skip the judge and preserve known destructive blocks');
    assert.equal(ctx.pentest.review.snapshot().grants.length, 0, 'Routine actions require no saved allowance');
    if (process.env.DSH_TEST_POLICY_SCREENSHOT) {
      await actionProfile.scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.DSH_TEST_POLICY_SCREENSHOT, fullPage: true });
    }
    await actionProfile.selectOption('review');
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => ctx.pentest.policyProfile === 'review');
    if (process.env.DSH_TEST_SCOPE_SCREENSHOT) await page.screenshot({ path: process.env.DSH_TEST_SCOPE_SCREENSHOT, fullPage: true });
    await page.getByRole('button', { name: 'Hide setup reminder', exact: true }).click();
    await poll(async () => (await ctx.pentest.toolSetup()).bannerDismissed);
    await page.reload(); await policy();
    assert.equal(await page.getByRole('button', { name: 'Hide setup reminder', exact: true }).count(), 0);
    await page.getByText('Manage destination allowances', { exact: true }).click();
    await page.getByLabel('Exact hostname or IP', { exact: true }).fill('API.EXAMPLE.TEST.');
    await page.getByRole('button', { name: 'Add destination allowance', exact: true }).click();
    await poll(() => ctx.pentest.review.snapshot().grants.some(grant => grant.host === 'api.example.test'));
    await page.getByRole('button', { name: /Saved allowances/ }).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await poll(() => ctx.pentest.review.snapshot().grants.length === 0);
    const { digest } = await import('../../packages/contracts/lib/index.js');
    const pending = ctx.pentest.review.run({sessionId: 'web-fixture', tool: 'model_request', arguments: {}, argumentsHash: digest({}), grants: new Set()},
      () => ctx.pentest.review.request('scope', {url:'https://pending.example.test/v1', purpose:'model'}, 'Fixture model connection', AbortSignal.timeout(15000)));
    await page.getByRole('button', { name: 'Always allow all calls to pending.example.test', exact: true }).click();
    assert.equal(await pending, true);
    await page.getByRole('button', { name: 'Revoke', exact: true }).click();
    await poll(() => ctx.pentest.review.snapshot().grants.length === 0);
    await editor.fill('{');
    await page.getByText('Scope draft needs attention:', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    assert.equal(ctx.pentest.scope.scope.targets.length, 0);
    const saved = JSON.parse(JSON.stringify(example).replaceAll('example.test', 'accepted.example.test'));
    saved.networks = ['192.0.2.0/24'];
    saved.services.telemetry = [{ host: 'logs.example.test', schemes: ['https'], ports: [443], pathPrefixes: ['/otlp'], allowPrivateAddresses: false }];
    await editor.fill(JSON.stringify(saved, null, 2));
    await page.getByRole('button', { name: 'Apply scope and policy', exact: true }).click();
    await poll(() => ctx.pentest.scope.scope.targets[0]?.host === 'www.prod.accepted.example.test');
    await page.reload(); await policy();
    assert.deepEqual(JSON.parse(await editor.inputValue()), saved);
    assert(await page.getByText('Default course scope', { exact: true }).count());
    await plugins();
    await page.getByText('Djupleita · REA & Ghidra', { exact: true }).click();
    await page.getByRole('button', { name: 'Show setup reminder', exact: true }).click();
    await poll(async () => !(await ctx.pentest.toolSetup()).bannerDismissed);
    await policy();
    await page.getByRole('button', { name: 'Hide setup reminder', exact: true }).waitFor();
    const savedScope = structuredClone(ctx.pentest.scope.scope);
    const savedBudget = ctx.pentest.engagement.snapshot();
    const { SessionId } = await import('../../vendor/deepseek-harness/packages/core/session/lib/index.js');
    const existingPentestAgent = (await ctx.agents.create({ sessionId: SessionId('existing-pentest-mode-fixture'), meta: { cwd: root, agentPreset: 'pentest' },
      setup: async inner => { await ctx.agentPresets.mount(inner, 'pentest'); } })).agent;
    await page.getByRole('button', { name: 'Turn off engagement layer', exact: true }).click();
    await poll(() => ctx.get('pentest') === undefined);
    await page.getByText('OFF · Basic DSH behavior.', { exact: false }).waitFor();
    assert.equal(ctx.pentestMode.enabled, false);
    assert(!ctx.tools.definitions().some(tool => tool.name.startsWith('pentest_')));
    await page.reload();
    await plugins();
    await page.getByText('Djupleita · Engagement and identities', { exact: true }).click();
    await page.getByRole('button', { name: 'Turn on engagement layer', exact: true }).waitFor();
    assert.equal(await page.locator('textarea[name="scope"]').count(), 0);
    const { ToolCallId } = await import('../../vendor/deepseek-harness/packages/llm/llm/lib/index.js');
    const { executeModelToolFixture } = await import('../../vendor/deepseek-harness/packages/test-support/tool-testkit/lib/index.js');
    await writeFile(join(root, 'basic-dsh.txt'), 'Basic DSH native read fixture');
    const agent = (await ctx.agents.create({ sessionId: SessionId('basic-mode-fixture'), meta: { cwd: root, agentPreset: 'standard' },
      setup: async inner => { await ctx.agentPresets.mount(inner, 'standard'); } })).agent;
    const freshPentestAgent = (await ctx.agents.create({ sessionId: SessionId('fresh-pentest-mode-fixture'), meta: { cwd: root, agentPreset: 'pentest' },
      setup: async inner => { await ctx.agentPresets.mount(inner, 'pentest'); } })).agent;
    for (const scoped of [agent, existingPentestAgent, freshPentestAgent]) {
      const prompt = JSON.stringify(await ctx.systemPrompt.assemble({ scope: scoped }));
      assert(!prompt.includes('authorized penetration testing assistant'));
      assert(!prompt.includes('Target scope management is'));
      assert(!prompt.includes('operator-provided engagement context'));
    }
    const result = await executeModelToolFixture(ctx, { agent, name: 'read', arguments: { file_path: join(root, 'basic-dsh.txt') },
      callId: ToolCallId('basic-mode-read'), signal: AbortSignal.timeout(5000) });
    assert(!result.isError);
    assert(JSON.stringify(result).includes('Basic DSH native read fixture'));
    await page.getByRole('button', { name: 'Turn on engagement layer', exact: true }).click();
    await poll(() => ctx.get('pentest') !== undefined && ctx.tools.get('pentest_http') !== undefined);
    await editor.waitFor();
    assert.deepEqual(ctx.pentest.scope.scope, savedScope);
    // The shared persona reaches existing standard agents and fresh pentest agents.
    const freshAgent = (await ctx.agents.create({ sessionId: SessionId('prompt-child-fixture'), meta: { cwd: root, agentPreset: 'pentest' },
      setup: async inner => { await ctx.agentPresets.mount(inner, 'pentest'); } })).agent;
    for (const scoped of [agent, freshAgent]) {
      const restored = JSON.stringify(await ctx.systemPrompt.assemble({ scope: scoped }));
      assert(restored.includes('operator-provided engagement context'));
      assert(restored.includes('bounded active testing'));
      assert(restored.includes('previous task-specific passive-only limit'));
      assert(restored.includes('Never work around a denied operation'));
      assert(restored.includes('not prerequisites for every active test'));
      assert(!restored.includes('load pentest_skill djupleita-assessment before testing'));
    }
    assert.equal(ctx.pentest.engagement.snapshot().requests, savedBudget.requests);
    assert.deepEqual(JSON.parse(await editor.inputValue()), savedScope);
    await page.reload(); await policy();
    await page.getByRole('button', { name: 'Turn off engagement layer', exact: true }).waitFor();
    if (process.env.DSH_TEST_UI_SCREENSHOT) await page.screenshot({ path: process.env.DSH_TEST_UI_SCREENSHOT, fullPage: true });
    const { checkEvidenceGraph } = await import('./evidence-graph-web.mjs');
    await checkEvidenceGraph(ctx, page);
    console.log(JSON.stringify({ evidenceGraph: true, redTeamProfile: true, judgeUnknownEffects: true, allowUnknownEffects: true, authenticatedWeb: true, productionWildcardException: true, courseScopeToggle: true, scopeDraftAndPersistence: true, scopePrefillWithServices: true, savedScopeMatchesAgent: true, basicDshMode: true, destinationManagement: true, setupHideAndRestore: true }));
  } finally { await browser.close(); }
} finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
