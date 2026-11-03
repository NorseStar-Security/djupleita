/** Native-store browser acceptance uses only unique synthetic credentials and a loopback site. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const log=console.log;console.log=(...args)=>{if(!String(args[0]).startsWith('dsh web:'))log(...args);};
const root=await mkdtemp(join(tmpdir(),'djupleita-plugin-ui-'));
process.env.PLAYWRIGHT_BROWSERS_PATH??=process.platform==='darwin'?join(process.env.HOME,'Library/Caches/ms-playwright'):join(process.env.HOME,'.cache/ms-playwright');
process.env.DSH_HOME=join(root,'home');
// macOS Keychain needs the logged-in account's home. Harness state remains isolated by DSH_HOME.
if(process.platform!=='darwin')process.env.HOME=join(root,'os-home');
process.env.DSH_PENTEST_ENGAGEMENT=join(root,'engagement.json');await mkdir(process.env.HOME,{recursive:true});
const require=createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
const {prepareProfile}=await import('../../scripts/profile.mjs');
const {nativeSecretProvider}=await import('../../packages/identities/lib/index.js');
const native=nativeSecretProvider(resolve('native/keychain-helper'));
let ctx,browser,page;const keys=[`fixture-${randomUUID()}`,`fixture-${randomUUID()}`,`fixture-${randomUUID()}`],references=[];
const paths=[];
const site=http.createServer((req,res)=>{paths.push(req.url);if(req.url==='/slow')return setTimeout(()=>res.end('slow fixture'),4000);res.setHeader('content-type','text/html');res.end(req.url==='/seed'?'<a href="/next">Next</a>':'Local crawl fixture');});
site.listen(0,'127.0.0.1');await once(site,'listening');const address=site.address(),origin=`http://127.0.0.1:${address.port}`;
const walk=async dir=>{const paths=[];for(const item of await readdir(dir,{withFileTypes:true})){const path=join(dir,item.name);if(item.isDirectory())paths.push(...await walk(path));else paths.push(path);}return paths;};
try {
  const template=JSON.parse(await readFile('configs/engagement.example.json','utf8'));
  template.id=randomUUID();
  template.scope={enabled:true,targets:[{host:'127.0.0.1',schemes:['http'],ports:[address.port],pathPrefixes:['/'],allowPrivateAddresses:true}],exclusions:[],networks:['127.0.0.1/32'],services:{intelligence:[],model:[],telemetry:[]}};
  template.budget.requestsPerSecond=100;template.budget.maxDepth=4;
  await writeFile(process.env.DSH_PENTEST_ENGAGEMENT,JSON.stringify(template));
  const profile=join(process.env.DSH_HOME,'profiles/pentest');await prepareProfile(profile);
  const patch=join(profile,'cordis.patch.yml');const doc=require('yaml').parseDocument(await readFile(patch,'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:value=>value}]});
  for(const row of doc.contents.items)for(const entry of row.get('insert')?.items??[])if(entry.get('id')==='pentest'){
    entry.get('config').get('policy').set('rules',[{id:'local-fixture',tools:['http_request'],effects:['read'],decision:'allow',reason:'Bounded loopback fixture'}]);
    entry.get('config').set('root',join(root,'engagements'));entry.get('config').set('plugins',{});entry.get('config').set('keychainHelper',resolve('native/keychain-helper'));
  }
  doc.contents.add(doc.createNode({id:'agent-default-model',config:{provider:'plugin-fixture',model:'offline'}}));
  await writeFile(patch,doc.toString({lineWidth:0}));
  const {bootProductionProfile}=await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const {provideCmdline}=await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  ctx=await bootProductionProfile({binName:'djupleita-fixture',profile:'pentest',overlayPaths:[patch],prepare(inner){provideCmdline(inner,{args:['--no-open','--host','127.0.0.1','--port','0'],exit(){},ready:{onReady(listener){queueMicrotask(listener);return()=>{};}}});}});
  const {LlmAdapter}=await import('../../vendor/deepseek-harness/packages/llm/llm/lib/index.js');
  class OfflineAdapter extends LlmAdapter {
    async listModels(provider){return [{provider,id:'offline',name:'Offline fixture'}];}
    async *stream(){throw new Error('This fixture must not make model calls');}
  }
  ctx.llm.registerAdapter(['plugin-fixture'],new OfflineAdapter());
  const {chromium}=await import('../../packages/browser/node_modules/playwright/index.mjs');browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1000},locale:'en-US'});page.setDefaultTimeout(15000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  assert.equal((await page.request.get(ctx.webServer.getOrigin())).status(),401);
  assert.equal((await page.request.post(`${ctx.webServer.getOrigin()}/api/pentest/credentials/save`,{data:{}})).status(),401);
  await page.goto(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
  await page.getByRole('dialog',{name:'Preview Notice'}).getByRole('button',{name:'Continue',exact:true}).click();
  const plugins=async()=>{await page.getByRole('button',{name:'Plugins',exact:true}).first().click();const back=page.getByRole('button',{name:'Back to plugins',exact:true});if(await back.count())await back.click();};
  const open=async title=>{await plugins();await page.getByText(`Djupleita · ${title}`,{exact:true}).click();};
  const poll=async test=>{for(let i=0;i<150;i++){if(await test())return;await new Promise(resolve=>setTimeout(resolve,40));}throw new Error('Plugin state did not settle');};
  await open('ProjectDiscovery recon');
  const keyInput=page.getByLabel('ProjectDiscovery Cloud API key',{exact:true});
  await keyInput.fill(keys[0]);assert.equal(await keyInput.getAttribute('type'),'password');
  await page.getByRole('button',{name:'Save ProjectDiscovery Cloud key',exact:true}).click();
  await poll(()=>Boolean(ctx.pentest.pluginConfig.intelligence.pdcpIdentityId));
  let identity=ctx.pentest.pluginConfig.intelligence.pdcpIdentityId;references.push(`${template.id}/${identity}`);
  assert.deepEqual(await ctx.pentest.identities.headers(identity,new URL('https://api.projectdiscovery.io/v1/domain/associated')),{'X-API-Key':keys[0]});
  assert.equal(await keyInput.inputValue(),'');
  await page.reload();await open('ProjectDiscovery recon');
  await page.getByRole('button',{name:'Replace ProjectDiscovery Cloud key',exact:true}).waitFor();
  assert.equal(await keyInput.inputValue(),'');
  await keyInput.fill(keys[1]);await page.getByRole('button',{name:'Replace ProjectDiscovery Cloud key',exact:true}).click();
  await poll(()=>ctx.pentest.pluginConfig.intelligence.pdcpIdentityId!==identity);
  const previous=identity;identity=ctx.pentest.pluginConfig.intelligence.pdcpIdentityId;references.push(`${template.id}/${identity}`);
  await poll(async()=>await native.get(`${template.id}/${previous}`)===undefined);
  assert.deepEqual(await ctx.pentest.identities.headers(identity,new URL('https://api.projectdiscovery.io/')),{'X-API-Key':keys[1]});
  await page.getByLabel('Subfinder provider',{exact:true}).fill('shodan');await page.getByLabel('Provider API key',{exact:true}).fill(keys[2]);
  await page.getByRole('button',{name:'Save Subfinder provider key',exact:true}).click();
  await poll(()=>Boolean(ctx.pentest.pluginConfig.recon.providerIdentities?.subfinder?.shodan));
  const cliIdentity=ctx.pentest.pluginConfig.recon.providerIdentities.subfinder.shodan;references.push(`${template.id}/${cliIdentity}`);
  assert.equal(await ctx.pentest.identities.apiKey(cliIdentity),keys[2]);assert(ctx.pentest.pluginConfig.recon.sources.includes('shodan'));
  const shots=process.env.DSH_PLUGIN_REVIEW_DIR;if(shots){await mkdir(shots,{recursive:true});await page.getByRole('heading',{name:'API keys',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'plugin-api-keys.png')});}
  // A full engagement unload/reload restores references from disk and keys from the native store.
  await plugins();await page.getByText('Djupleita · Engagement and identities',{exact:true}).click();
  await page.getByRole('button',{name:'Turn off engagement layer',exact:true}).click();
  await page.getByRole('button',{name:'Turn on engagement layer',exact:true}).click();
  await page.getByLabel('Scope management',{exact:true}).waitFor();
  assert.deepEqual(await ctx.pentest.identities.headers(identity,new URL('https://api.projectdiscovery.io/')),{'X-API-Key':keys[1]});
  await open('Scoped crawling');
  assert.equal(await page.getByRole('button',{name:'Policy',exact:true}).count(),0);
  assert.equal(await page.locator('textarea[name="scope"]').count(),0);
  await page.getByRole('button',{name:'Open shared engagement policy',exact:true}).click();
  await page.locator('textarea[name="scope"]').waitFor();
  await open('Scoped crawling');
  await page.getByText('Crawl limits',{exact:true}).click();await page.getByLabel('Pages per run',{exact:true}).fill('1');
  await page.getByRole('button',{name:'Apply crawl limits',exact:true}).click();await poll(()=>ctx.pentest.frontier.config.maxPages===1);
  await page.getByLabel('Seed URLs',{exact:true}).fill(`${origin}/seed\nhttps://outside.example.test/`);
  await page.getByRole('button',{name:'Add seeds to queue',exact:true}).click();await poll(()=>ctx.pentest.frontier.snapshot().queued.length===1);
  assert.equal(paths.length,0,'Adding seed URLs does not send traffic');
  await page.getByRole('button',{name:'Start crawl',exact:true}).click();
  await poll(()=>ctx.pentest.crawlControls.snapshot().report?.stop==='page-budget');
  assert.deepEqual(paths,['/seed']);assert.equal(ctx.pentest.frontier.snapshot().queued.length,1);
  const snapshot=ctx.pentest.crawlControls.snapshot();assert(snapshot.rejected.some(item=>item.url==='https://outside.example.test/'));
  if(shots){await page.getByText('Crawl stopped: page-budget · 1 pages fetched',{exact:true}).waitFor();await page.getByText('Crawl limits',{exact:true}).click();await page.getByRole('heading',{name:'Scoped crawling',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(shots,'crawl-controls.png')});await page.getByText('Crawl limits',{exact:true}).click();}
  // Apply resets the frontier; stopping cancels the actual in-flight request.
  await page.getByRole('button',{name:'Apply crawl limits',exact:true}).click();
  await page.getByLabel('Seed URLs',{exact:true}).fill(`${origin}/slow`);await page.getByRole('button',{name:'Add seeds to queue',exact:true}).click();
  await poll(()=>ctx.pentest.frontier.snapshot().queued.length===1);await page.getByRole('button',{name:'Start crawl',exact:true}).click();
  await poll(()=>paths.includes('/slow'));await page.getByRole('button',{name:'Stop crawl',exact:true}).click();await poll(()=>!ctx.pentest.crawlControls.snapshot().running);
  assert.equal(ctx.pentest.crawlControls.snapshot().report?.stop,'cancelled');
  // A manual start must surface a real shared-policy approval before sending traffic.
  const policy=(await ctx.pentest.snapshot()).policy;
  await ctx.pentest.updateSettings(ctx.pentest.scope.scope,{...policy,rules:[{id:'owner-fixture-review',tools:['http_request'],effects:['read'],decision:'ask',reason:'Review local fixture crawl'}]},'djupleita-settings');
  await page.getByLabel('Seed URLs',{exact:true}).fill(`${origin}/approval`);await page.getByRole('button',{name:'Add seeds to queue',exact:true}).click();
  await poll(()=>ctx.pentest.frontier.snapshot().queued.length===1);await page.getByRole('button',{name:'Start crawl',exact:true}).click();
  await poll(()=>ctx.pentest.review.snapshot().pending.length===1);assert(!paths.includes('/approval'));
  await page.getByRole('button',{name:'Open shared engagement policy',exact:true}).click();
  await page.getByRole('button',{name:'Allow once',exact:true}).click();await poll(()=>paths.includes('/approval'));
  await poll(()=>!ctx.pentest.crawlControls.snapshot().running);
  await open('ProjectDiscovery recon');await page.getByRole('button',{name:'Remove ProjectDiscovery Cloud key',exact:true}).click();
  await poll(()=>!ctx.pentest.pluginConfig.intelligence.pdcpIdentityId);await poll(async()=>await native.get(`${template.id}/${identity}`)===undefined);
  await page.getByRole('button',{name:'Remove shodan · Subfinder key',exact:true}).click();await poll(()=>!ctx.pentest.pluginConfig.recon.providerIdentities?.subfinder?.shodan);
  for(const path of await walk(ctx.pentest.root)){const bytes=await readFile(path);for(const key of keys)assert(!bytes.includes(Buffer.from(key)),`Credential persisted in ${path}`);}
  assert.deepEqual(errors,[]);assert.deepEqual(paths,['/seed','/slow','/approval']);
  console.log(JSON.stringify({authenticatedWeb:true,nativeKeys:true,keyRotation:true,noPersistedKeys:true,crawlControls:true,sharedPolicyNavigation:true,localRequestsOnly:true}));
}catch(error){
  if(page && process.env.DSH_PLUGIN_REVIEW_DIR){await mkdir(process.env.DSH_PLUGIN_REVIEW_DIR,{recursive:true});await page.screenshot({path:join(process.env.DSH_PLUGIN_REVIEW_DIR,'failure.png')});await writeFile(join(process.env.DSH_PLUGIN_REVIEW_DIR,'failure.txt'),await page.locator('body').innerText());if(ctx?.pentest)await writeFile(join(process.env.DSH_PLUGIN_REVIEW_DIR,'crawl-failure.json'),JSON.stringify(ctx.pentest.crawlControls.snapshot()));}
  throw error;
}finally{
  for(const reference of references)await native.remove(reference).catch(()=>{});
  if(ctx?.pentest)for(const item of ctx.pentest.identities.list())if(item.pluginCredential)await native.remove(`${ctx.pentest.config.engagement.id}/${item.id}`).catch(()=>{});
  await browser?.close();await ctx?.fiber.dispose();site.closeAllConnections();await new Promise(resolve=>site.close(resolve));await rm(root,{recursive:true,force:true});
}
