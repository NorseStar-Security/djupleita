/** Plugin failure recovery against an isolated authenticated Host; no model or target calls. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const log = console.log;
console.log = (...args) => { if (!String(args[0]).startsWith('dsh web:')) log(...args); };
const root = await mkdtemp(join(tmpdir(), 'djupleita-plugin-settings-'));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= process.platform === 'darwin' ? join(process.env.HOME, 'Library/Caches/ms-playwright') : join(process.env.HOME, '.cache/ms-playwright');
process.env.DSH_HOME = join(root, 'home');
process.env.HOME = join(root, 'os-home');
process.env.DSH_PENTEST_ENGAGEMENT = join(root, 'engagement.json');
await mkdir(process.env.HOME, { recursive: true });
const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
let ctx, browser;
try {
  const template = JSON.parse(await readFile('configs/engagement.example.json', 'utf8'));
  template.scope = { enabled: true, targets: [{ host: 'app.example.test', schemes: ['https'], ports: [443], pathPrefixes: ['/'], allowPrivateAddresses: false }], exclusions: [], networks: [], services: { intelligence: [], model: [], telemetry: [] } };
  await writeFile(process.env.DSH_PENTEST_ENGAGEMENT, JSON.stringify(template));
  const { prepareProfile } = await import('../../scripts/profile.mjs');
  const profile = join(process.env.DSH_HOME, 'profiles/pentest');
  await prepareProfile(profile);
  const patch = join(profile, 'cordis.patch.yml');
  const doc = require('yaml').parseDocument(await readFile(patch, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  for (const row of doc.contents.items) for (const entry of row.get('insert')?.items ?? []) if (entry.get('id') === 'pentest') {
    entry.get('config').set('root', join(root, 'engagements'));
    entry.get('config').set('plugins', {});
    entry.get('config').set('keychainHelper', '/unused-fixture-helper');
  }
  doc.contents.add(doc.createNode({ id: 'agent-default-model', config: { provider: 'plugin-fixture', model: 'offline' } }));
  await writeFile(patch, doc.toString({ lineWidth: 0 }));
  const { bootProductionProfile } = await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const { provideCmdline } = await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  ctx = await bootProductionProfile({ binName: 'djupleita-fixture', profile: 'pentest', overlayPaths: [patch], prepare(inner) {
    provideCmdline(inner, { args: ['--no-open', '--host', '127.0.0.1', '--port', '0'], exit() {}, ready: { onReady(listener) { queueMicrotask(listener); return () => {}; } } });
  } });
  const { LlmAdapter } = await import('../../vendor/deepseek-harness/packages/llm/llm/lib/index.js');
  class OfflineAdapter extends LlmAdapter {
    async listModels(provider) { return [{ provider, id: 'offline', name: 'Offline fixture' }]; }
    async *stream() { throw new Error('This fixture must not make model calls'); }
  }
  ctx.llm.registerAdapter(['plugin-fixture'], new OfflineAdapter());
  const { chromium } = await import('../../packages/browser/node_modules/playwright/index.mjs');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  let failure, modeFailure = 0;
  await page.route('**/api/pentest/snapshot', async route => {
    if (failure === 'network') return route.fulfill({ status: 503, body: 'Synthetic offline fixture' });
    const response = await route.fetch();
    if (failure !== 'render') return route.fulfill({ response });
    const body = await response.json();
    // An incompatible snapshot must produce a recoverable error, never retire the plugin slot silently.
    delete body.result.value.graph;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/djupleita/mode', route => modeFailure
    ? route.fulfill({ status: modeFailure, body: 'Synthetic offline fixture' }) : route.continue());
  assert.equal((await page.request.get(ctx.webServer.getOrigin())).status(), 401);
  await page.goto(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
  await page.getByRole('dialog', { name: 'Preview Notice' }).getByRole('button', { name: 'Continue', exact: true }).click();
  const open = async title => {
    await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
    const back = page.getByRole('button', { name: 'Back to plugins', exact: true });
    if (await back.count()) await back.click();
    await page.getByText(`Djupleita · ${title}`, { exact: true }).click();
  };
  await open('Engagement and identities');
  const editor = page.locator('textarea[name="scope"]');
  await editor.waitFor();
  const draft = JSON.stringify({ ...template.scope, exclusions: ['draft.example.test'] }, null, 2);
  await editor.fill(draft);
  await editor.evaluate(node => { window.fixtureScopeEditor = node; });
  failure = 'network';
  await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor();
  assert.equal(await editor.inputValue(), draft);
  assert(await editor.evaluate(node => node === window.fixtureScopeEditor), 'A failed refresh must keep the same editor mounted');
  failure = 'render';
  const errorPanel = page.getByRole('alert', { name: 'Djupleita panel error' });
  try { await errorPanel.waitFor(); } catch (error) {
    assert(await page.locator('[data-slot-error="plugins.item"]').count() > 0);
    assert.equal(await editor.count(), 0);
    throw new Error('Injected render failure reproduced silent plugin disappearance', { cause: error });
  }
  assert.equal(await page.locator('[data-slot-error]').count(), 0, 'A local failure must not retire the DSH plugin slot');
  assert.equal(await page.getByRole('button', { name: 'Turn off engagement layer', exact: true }).count(), 1, 'The master off switch must survive an editor crash');
  await page.getByRole('heading', { name: 'Djupleita · Engagement and identities', exact: true }).waitFor();
  assert.deepEqual((await ctx.pentest.snapshot()).engagement.scope, template.scope, 'Failed rendering and drafts cannot change the saved scope');
  failure = undefined;
  await page.getByRole('button', { name: 'Reload Djupleita panel', exact: true }).click();
  await editor.waitFor();
  assert.deepEqual(JSON.parse(await editor.inputValue()), template.scope);
  assert.equal(await errorPanel.count(), 0);
  // A broken editor must leave the owner able to unload the real server layer.
  failure = 'render';
  await errorPanel.waitFor();
  await page.getByRole('button', { name: 'Turn off engagement layer', exact: true }).click();
  await page.getByRole('button', { name: 'Turn on engagement layer', exact: true }).waitFor();
  assert.equal(ctx.get('pentest'), undefined);
  assert(!ctx.tools.definitions().some(tool => tool.name.startsWith('pentest_')));
  failure = undefined;
  await page.reload();
  await open('Engagement and identities');
  await page.getByRole('button', { name: 'Turn on engagement layer', exact: true }).click();
  await editor.waitFor();
  assert.deepEqual(JSON.parse(await editor.inputValue()), template.scope);
  modeFailure = 404;
  await page.reload();
  await open('Engagement and identities');
  await page.getByRole('alert').filter({ hasText: '/api/djupleita/mode returned HTTP 404' }).waitFor();
  assert(await page.getByRole('button', { name: 'Engagement switch unavailable', exact: true }).isDisabled());
  assert.equal(await page.getByText('ON · Pentest tools, policy, budgets and evidence recording are active.', { exact: true }).count(), 0);
  assert(ctx.get('pentest'), 'An unavailable control must never pretend to disable the server layer');
  modeFailure = 0;
  await page.getByRole('button', { name: 'Retry engagement status', exact: true }).click();
  await page.getByRole('button', { name: 'Turn off engagement layer', exact: true }).waitFor();
  modeFailure = 503;
  await page.reload();
  await open('ProjectDiscovery recon');
  await page.getByRole('alert').filter({ hasText: 'HTTP 503' }).waitFor();
  await page.getByRole('button', { name: 'Retry engagement status', exact: true }).waitFor();
  modeFailure = 0;
  await page.getByRole('button', { name: 'Retry engagement status', exact: true }).click();
  await page.getByRole('heading', { name: 'API keys', exact: true }).waitFor();
  assert.equal(await page.locator('[data-slot-error]').count(), 0);
  const pluginEditor = page.locator('textarea[name="config"]');
  await pluginEditor.waitFor();
  const savedPluginConfig = await pluginEditor.inputValue();
  failure = 'render';
  await errorPanel.waitFor();
  assert.equal(await page.locator('[data-slot-error]').count(), 0);
  failure = undefined;
  await page.getByRole('button', { name: 'Reload Djupleita panel', exact: true }).click();
  await pluginEditor.waitFor();
  assert.equal(await pluginEditor.inputValue(), savedPluginConfig);
  console.log(JSON.stringify({ authenticatedWeb: true, refreshPreservesDraft: true, visibleRenderFailure: true, retryRecovers: true, modeFailureVisible: true, offSurvivesEditorFailure: true, missingModeExplained: true }));
} finally {
  await browser?.close();
  await ctx?.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
