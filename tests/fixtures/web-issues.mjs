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
  await prepareProfile(profile);
  const path = join(profile, 'cordis.patch.yml');
  // Preserve executable platform expressions through a document edit.
  const doc = require('yaml').parseDocument(await readFile(path, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  for (const row of doc.contents.items) for (const entry of row.get('insert')?.items ?? []) {
    if (entry.get('id') === 'pentest') {
      entry.get('config').set('root', join(root, 'engagements'));
      entry.get('config').set('plugins', {});
      entry.get('config').set('keychainHelper', '/unused-fixture-helper');
    }
  }
  await writeFile(path, doc.toString({ lineWidth: 0 }));
  const { bootProductionProfile } = await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const { provideCmdline } = await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  ctx = await bootProductionProfile({ binName: 'djupleita-fixture', profile: 'pentest', overlayPaths: [path], prepare(inner) {
    provideCmdline(inner, { args: ['--no-open', '--host', '127.0.0.1', '--port', '0'], exit() {}, ready: { onReady() { return () => {}; } } });
  } });
  const { chromium } = await import('../../packages/browser/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
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
    const editor = page.locator('textarea[name="scope"]');
    const example = JSON.parse(await readFile(resolve('configs/scope.example.json'), 'utf8'));
    assert.deepEqual(JSON.parse(await editor.inputValue()), example);
    assert.equal(ctx.pentest.scope.scope.targets.length, 0, 'Draft must remain inactive');
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
    await poll(() => ctx.pentest.scope.scope.targets[0]?.host === 'accepted.example.test');
    await page.reload(); await policy();
    assert.deepEqual(JSON.parse(await editor.inputValue()), saved);
    assert(await page.getByText('Working target and exclusion example', { exact: true }).count());
    await plugins();
    await page.getByText('Djupleita · REA & Ghidra', { exact: true }).click();
    await page.getByRole('button', { name: 'Show setup reminder', exact: true }).click();
    await poll(async () => !(await ctx.pentest.toolSetup()).bannerDismissed);
    await policy();
    await page.getByRole('button', { name: 'Hide setup reminder', exact: true }).waitFor();
    if (process.env.DSH_TEST_UI_SCREENSHOT) await page.screenshot({ path: process.env.DSH_TEST_UI_SCREENSHOT, fullPage: true });
    console.log(JSON.stringify({ authenticatedWeb: true, scopeDraftAndPersistence: true, destinationManagement: true, setupHideAndRestore: true }));
  } finally { await browser.close(); }
} finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
