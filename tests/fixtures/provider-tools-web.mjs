/** Browser acceptance through the authenticated production web app in a private home. */
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const log = console.log;
console.log = (...args) => { if (!String(args[0]).startsWith('dsh web:')) log(...args); };
const root = await mkdtemp(join(tmpdir(), 'djupleita-provider-web-'));
process.env.DSH_HOME = join(root, 'home');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= process.platform === 'darwin' ? join(process.env.HOME, 'Library/Caches/ms-playwright') : join(process.env.HOME, '.cache/ms-playwright');
process.env.HOME = join(root, 'os-home');
process.env.DSH_PENTEST_ENGAGEMENT = join(root, 'engagement.json');
await mkdir(process.env.HOME, { recursive: true });
const { prepareProfile } = await import('../../scripts/profile.mjs');
const profile = join(process.env.DSH_HOME, 'profiles/pentest');
const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
let ctx, providerFailure, toolReplies = 0;
const model = 'accounts/fireworks/routers/deepseek-flash-latest';
const provider = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const tools = body.tools ?? [];
    if (tools.length) {
      const rea = tools.find(tool => tool.name === 'pentest_rea').input_schema;
      assert(!JSON.stringify(rea).includes('"$ref"'), 'REA must not contain orphaned references');
      const assessment = tools.find(tool => tool.name === 'pentest_assessment').input_schema;
      assert(assessment.properties.operation && assessment.properties.plan && assessment.properties.runId, 'Assessment fields must survive serialization');
    }
    const hasResult = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_result'));
    const callTool = tools.length && !hasResult;
    if (hasResult) {
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result');
      assert(results.every(result => result.is_error !== true), 'The trusted status tool must succeed');
      toolReplies++;
    }
    const frames = [
      {type:'message_start',message:{id:'msg_fixture',type:'message',role:'assistant',model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:10,output_tokens:1}}},
      {type:'content_block_start',index:0,content_block:callTool ? {type:'tool_use',id:'call_fixture',name:'pentest_status',input:{}} : {type:'text',text:''}},
      {type:'content_block_delta',index:0,delta:callTool ? {type:'input_json_delta',partial_json:'{}'} : {type:'text_delta',text:'Provider tool fixture complete'}},
      {type:'content_block_stop',index:0},
      {type:'message_delta',delta:{stop_reason:callTool?'tool_use':'end_turn',stop_sequence:null},usage:{output_tokens:1}},
      {type:'message_stop'},
    ];
    response.writeHead(200, {'content-type':'text/event-stream'});
    response.end(frames.map(frame => 'event: '+frame.type+'\ndata: '+JSON.stringify(frame)+'\n\n').join(''));
  } catch (error) {
    providerFailure = error;
    response.writeHead(400, {'content-type':'application/json'}); response.end(JSON.stringify({type:'error',error:{type:'invalid_request_error',message:'Local schema fixture rejected request'}}));
  }
});
provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
const providerURL = 'http://127.0.0.1:'+provider.address().port;
process.env.DJUPLEITA_PROVIDER_FIXTURE_KEY = 'synthetic-provider-fixture';
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
  doc.contents.add(doc.createNode({id:'llm-pi-ai',config:{providers:{
    fireworks:{apiKeyEnv:'DJUPLEITA_PROVIDER_FIXTURE_KEY',baseURL:providerURL},
  }}}));
  doc.contents.add(doc.createNode({id:'agent-default-model',config:{provider:'fireworks',model}}));
  await writeFile(path, doc.toString({ lineWidth: 0 }));
  const { bootProductionProfile } = await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const { provideCmdline } = await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  ctx = await bootProductionProfile({ binName: 'djupleita-fixture', profile: 'pentest', overlayPaths: [path], prepare(inner) {
    provideCmdline(inner, { args: ['--no-open', '--host', '127.0.0.1', '--port', '0'], exit() {}, ready: { onReady(listener) { queueMicrotask(listener); return () => {}; } } });
  } });

  const initialScope = structuredClone(ctx.pentest.scope.scope);
  await ctx.workspaceRegistry.create(root, 'Provider fixture');
  const { chromium } = await import('../../packages/browser/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(7000);
    assert.equal((await page.request.get(ctx.webServer.getOrigin())).status(), 401);
    await page.goto(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
    await page.getByRole('dialog', {name:'Preview Notice'}).getByRole('button', {name:'Continue',exact:true}).click();
    await page.getByRole('button', {name:'New session',exact:true}).first().click();
    await page.getByRole('button', {name:'Choose workspace',exact:true}).click();

    await page.getByRole('menuitem', {name:'Provider fixture',exact:true}).click();
    const composer = page.getByRole('textbox', {name:/^(?:Message or run a task|Describe what you want to build), \/ commands, @ files or sessions$/});
    await composer.fill('Local provider fixture');
    await page.getByRole('button', {name:'Send message',exact:true}).click();
    await page.getByText('Provider tool fixture complete', {exact:true}).first().waitFor({timeout:30000});
    if (providerFailure) throw providerFailure;
    assert(toolReplies > 0, 'The browser turn must execute a tool and return its result to the provider');
    assert.equal(ctx.pentest.review.snapshot().pending.length, 0);
    assert.deepEqual(ctx.pentest.scope.scope, initialScope);
    console.log(JSON.stringify({authenticatedWeb:true,providerSerialization:true,streaming:true,toolRoundTrip:true,engagementScopeUnchanged:true}));
  } finally { await browser.close(); }
} finally {
  await ctx?.fiber.dispose();
  provider.closeAllConnections(); provider.close(); await once(provider, 'close');
  await rm(root, { recursive: true, force: true });
}
