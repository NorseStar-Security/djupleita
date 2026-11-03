/** Keyless replay acceptance in the shipped authenticated web app, isolated from user state. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const log = console.log;
console.log = (...args) => { if (!String(args[0]).startsWith('dsh web:')) log(...args); };
const root = await mkdtemp(join(tmpdir(), 'djupleita-replay-web-'));
process.env.PLAYWRIGHT_BROWSERS_PATH ??= process.platform === 'darwin' ? join(process.env.HOME, 'Library/Caches/ms-playwright') : join(process.env.HOME, '.cache/ms-playwright');
process.env.DSH_HOME = join(root, 'home');
process.env.HOME = join(root, 'os-home');
process.env.DSH_PENTEST_ENGAGEMENT = join(root, 'engagement.json');
await mkdir(process.env.HOME, { recursive: true });
const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
const { prepareProfile } = await import('../../scripts/profile.mjs');
const profile = join(process.env.DSH_HOME, 'profiles/pentest');
let ctx, browser;
const requests = [];
try {
  const template = JSON.parse(await readFile('configs/engagement.example.json', 'utf8'));
  template.scope = { enabled: true, targets: [{host:'app.example.test',schemes:['https'],ports:[443],pathPrefixes:['/'],allowPrivateAddresses:false}], exclusions: [], networks: [], services: {intelligence:[],model:[],telemetry:[]} };
  await writeFile(process.env.DSH_PENTEST_ENGAGEMENT, JSON.stringify(template));
  await prepareProfile(profile);
  const path = join(profile, 'cordis.patch.yml');
  const doc = require('yaml').parseDocument(await readFile(path, 'utf8'), {customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}]});
  for (const row of doc.contents.items) for (const entry of row.get('insert')?.items ?? []) if (entry.get('id') === 'pentest') {
    entry.get('config').set('root', join(root, 'engagements'));
    entry.get('config').set('plugins', {});
    entry.get('config').set('keychainHelper', '/unused-fixture-helper');
  }
  doc.contents.add(doc.createNode({id:'agent-default-model',config:{provider:'replay-fixture-a',model:'original-model'}}));
  await writeFile(path, doc.toString({lineWidth:0}));
  const { bootProductionProfile } = await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const { provideCmdline } = await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  const port = process.env.DSH_REPLAY_FIXTURE_PORT ?? '0';
  ctx = await bootProductionProfile({binName:'djupleita-fixture',profile:'pentest',overlayPaths:[path],prepare(inner) {
    provideCmdline(inner,{args:['--no-open','--host','127.0.0.1','--port',port],exit(){},ready:{onReady(listener){queueMicrotask(listener);return()=>{};}}});
  }});
  const { LlmAdapter } = await import('../../vendor/deepseek-harness/packages/llm/llm/lib/index.js');
  class FixtureAdapter extends LlmAdapter {
    async listModels(provider) { return [{provider,id:provider.endsWith('-a')?'original-model':'selected-model',name:provider.endsWith('-a')?'Original fixture model':'Selected fixture model'}]; }
    async resolveModel(provider, model) { return {provider,id:model,name:model,context:{contextWindow:128000},reasoning:{efforts:[{id:'high',name:'High'}],defaultEffort:'high'}}; }
    async *stream(options) {
      requests.push(options);
      const messages = JSON.stringify(options.messages);
      const text = messages.includes('FRESH_REPLAY_REQUEST') ? 'FRESH_REPLAY_DONE' : messages.includes('HISTORY_REPLAY_REQUEST') ? 'HISTORY_REPLAY_DONE' : messages.includes('SELECTED_ORIGINAL_REQUEST') ? 'SELECTED_ORIGINAL_ANSWER' : messages.includes('EARLIER_HISTORY_CANARY') ? 'EARLIER_HISTORY_ANSWER' : 'Replay fixture';
      yield {type:'block-start',index:0,blockType:'text'};
      yield {type:'text-delta',index:0,text};
      yield {type:'block-end',index:0,block:{type:'text',text}};
      yield {type:'finish',reason:{kind:'stop'}};
    }
  }
  ctx.llm.registerAdapter(['replay-fixture-a','replay-fixture-b'],new FixtureAdapter());
  await ctx.workspaceRegistry.create(root, 'Replay fixture');
  const { chromium } = await import('../../packages/browser/node_modules/playwright/index.mjs');
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000},locale:'en-US'});
  page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  assert.equal((await page.request.get(ctx.webServer.getOrigin())).status(),401);
  await page.goto(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
  await page.getByRole('dialog',{name:'Preview Notice'}).getByRole('button',{name:'Continue',exact:true}).click();
  await page.getByRole('button',{name:'New session',exact:true}).first().click();
  await page.getByRole('button',{name:'Choose workspace',exact:true}).click();
  await page.getByRole('menuitem',{name:'Replay fixture',exact:true}).click();
  const composer=page.getByRole('textbox',{name:/^(?:Message or run a task|Describe what you want to build), \/ commands, @ files or sessions$/});
  for(const [prompt,answer] of [['EARLIER_HISTORY_CANARY','EARLIER_HISTORY_ANSWER'],['SELECTED_ORIGINAL_REQUEST','SELECTED_ORIGINAL_ANSWER']]) {
    await composer.fill(prompt);await page.getByRole('button',{name:'Send message',exact:true}).click();await page.getByText(answer,{exact:true}).last().waitFor();
    if(prompt==='EARLIER_HISTORY_CANARY') {
      const owner=ctx.agents.list().find(agent=>agent.session.deriveMessages().some(message=>JSON.stringify(message).includes(prompt)));
      await owner.whenIdle();
      const goal=ctx.goals.create(owner,{objective:'EARLIER_GOAL_CANARY'});
      ctx.goals.pause(owner,goal);
    }
  }
  const source=ctx.agents.list().find(agent=>agent.session.deriveMessages().some(message=>JSON.stringify(message).includes('SELECTED_ORIGINAL_REQUEST')));
  assert(source); await source.whenIdle();
  const sourceEvents=source.session.snapshotEvents();
  const anchor=sourceEvents.filter(event=>event.type==='user/message' && event.data.source.kind==='user').at(-1);
  const hideSetup=page.getByRole('button',{name:'Hide setup reminder',exact:true});
  if(await hideSetup.count()) await hideSetup.click();
  await page.getByRole('button',{name:/^Pending approvals:/}).click();
  const editor=page.getByRole('textbox',{name:'Edit and replay',exact:true});
  const open=async()=>{await page.getByRole('button',{name:'Edit and replay',exact:true}).last().click();};
  await open();
  await editor.fill('FRESH_REPLAY_REQUEST');
  // The existing composer switcher stays usable while the inline editor is open.
  await page.getByRole('button',{name:/^Select model(?:,|$)/}).click();
  const modelPane=page.getByRole('menuitem',{name:/^Model/});
  if(await modelPane.count()) await modelPane.click();
  await page.getByRole('menuitemradio',{name:'Selected fixture model',exact:true}).click();
  await page.getByRole('button',{name:/Select model, current Selected fixture model/}).waitFor();
  const original=JSON.stringify(source.session.snapshotEvents());
  for(const width of [390,1440]) {
    await page.setViewportSize({width,height:1000});await editor.scrollIntoViewIfNeeded();
    const box=await editor.locator('xpath=ancestor::form').boundingBox();assert(box && box.x>=0 && box.x+box.width<=width);
  }
  const shot=process.env.DSH_REPLAY_REVIEW_DIR;
  if(shot) {await page.getByRole('button',{name:'Replay in new chat',exact:true}).scrollIntoViewIfNeeded();await mkdir(shot,{recursive:true});await page.screenshot({path:join(shot,'replay-options.png')});}
  await page.getByRole('button',{name:'Replay in new chat',exact:true}).click();
  await page.getByText('FRESH_REPLAY_DONE',{exact:true}).last().waitFor();
  const fresh=ctx.agents.list().find(agent=>agent.id!==source.id && agent.session.deriveMessages().some(message=>JSON.stringify(message).includes('FRESH_REPLAY_REQUEST')));
  assert(fresh);await fresh.whenIdle();
  assert.equal(fresh.session.inheritedEventCount,0);
  assert.equal(ctx.goals.get(fresh),undefined);
  await page.getByRole('button',{name:/Select model, current Selected fixture model/}).waitFor();
  const input=requests.findLast(request=>JSON.stringify(request.messages).includes('FRESH_REPLAY_REQUEST'));
  assert(input);assert.equal(input.provider,'replay-fixture-b');assert.equal(input.model,'selected-model');assert.equal(input.reasoningEffort,'high');
  assert(!JSON.stringify(input.messages).includes('EARLIER_HISTORY_CANARY'));
  assert(!JSON.stringify(input.messages).includes('SELECTED_ORIGINAL_REQUEST'));
  assert(!JSON.stringify(input.messages).includes('SELECTED_ORIGINAL_ANSWER'));
  assert.equal(await page.getByText('EARLIER_HISTORY_CANARY',{exact:true}).count(),0);
  assert.equal(JSON.stringify(source.session.snapshotEvents()),original);
  // Open the original using its rendered row, then exercise the retaining mode too.
  await page.locator(`[data-row-key="session:${source.id}"]`).click();
  await page.getByText('SELECTED_ORIGINAL_REQUEST',{exact:true}).waitFor();
  await open();await editor.fill('HISTORY_REPLAY_REQUEST');
  await page.getByRole('button',{name:'Replay with earlier history',exact:true}).click();
  await page.getByText('HISTORY_REPLAY_DONE',{exact:true}).last().waitFor();
  const retainedInput=requests.findLast(request=>JSON.stringify(request.messages).includes('HISTORY_REPLAY_REQUEST'));
  assert(retainedInput);assert(JSON.stringify(retainedInput.messages).includes('EARLIER_HISTORY_CANARY'));
  assert(!JSON.stringify(retainedInput.messages).includes('SELECTED_ORIGINAL_REQUEST'));
  assert.equal(retainedInput.provider,'replay-fixture-b');assert.equal(retainedInput.model,'selected-model');
  const retained=ctx.agents.list().find(agent=>agent.id!==source.id && agent.session.deriveMessages().some(message=>JSON.stringify(message).includes('HISTORY_REPLAY_REQUEST')));
  assert.equal(retained.session.inheritedEventCount,anchor.seq);
  assert.equal(ctx.goals.get(retained)?.objective,'EARLIER_GOAL_CANARY');
  assert.equal(ctx.goals.get(retained)?.phase,'paused');
  assert.equal(JSON.stringify(source.session.snapshotEvents()),original);
  assert.equal(ctx.pentest.engagement.snapshot().requests,0);
  assert.deepEqual(errors,[]);
  if(shot) await page.screenshot({path:join(shot,'replay-history.png')});
  console.log(JSON.stringify({authenticatedWeb:true,freshHistoryEmpty:true,retainedHistory:true,selectedProvider:true,selectedReasoning:true,sourceUnchanged:true,targetRequests:0}));
  if(process.env.DSH_REPLAY_FIXTURE_HOLD) {
    await writeFile(process.env.DSH_REPLAY_FIXTURE_HOLD,ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()),{mode:0o600});
    await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});
  }
} finally {
  await browser?.close();await ctx?.fiber.dispose();await rm(root,{recursive:true,force:true});
}
