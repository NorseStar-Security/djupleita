import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PentestRuntime, PluginConfigSchema } from '../packages/dsh-plugin/src/runtime.ts';
import { ServiceJsonClient } from '../packages/http/src/index.ts';
import { nativeSecretProvider } from '../packages/identities/src/index.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';
import { id } from '../packages/contracts/src/index.ts';
import type { SecretProvider } from '../packages/identities/src/index.ts';
const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function fixture(secrets?:SecretProvider) {
  const root=await mkdtemp(join(tmpdir(),'djupleita-plugin-controls-'));roots.push(root);
  const values=new Map<string,string>();
  const store=secrets??{async get(key:string){return values.get(key);},async set(key:string,value:string){values.set(key,value);},async remove(key:string){values.delete(key);}};
  const config={engagement:engagement(),policy:policyConfig,root,keychainHelper:resolve('native/keychain-helper'),secrets:store};
  return {runtime:await PentestRuntime.open(config,testJudge),values,config};
}
async function files(root:string):Promise<string[]> {
  const all:string[]=[];for(const entry of await readdir(root,{withFileTypes:true})) {const path=join(root,entry.name);if(entry.isDirectory())all.push(...await files(path));else all.push(path);}return all;
}
it('stores and rotates plugin keys without persisting values; restores references and deletes managed records',async()=>{
  const f=await fixture();let runtime=f.runtime;
  const session=id<'SessionId'>(), first=`fixture-${id<'Key'>()}`,second=`fixture-${id<'Key'>()}`;
  try {
    await runtime.credentials.save({slot:'pdcp',secret:first},session);
    const identity=runtime.pluginConfig.intelligence.pdcpIdentityId!;
    expect(await runtime.identities.headers(identity as never,new URL('https://api.projectdiscovery.io/v1/domain/associated'))).toEqual({'X-API-Key':first});
    await expect(runtime.identities.headers(identity as never,new URL('https://other.example.test/'))).rejects.toMatchObject({code:'CREDENTIAL_DESTINATION'});
    expect(runtime.credentials.status().entries.find(entry=>entry.slot==='pdcp')?.configured).toBe(true);
    expect(runtime.redactor.text(first)).toBe('[REDACTED]');
    const stateRoot=runtime.root;
    await runtime.close();runtime=await PentestRuntime.open(f.config,testJudge);
    expect(await runtime.identities.headers(identity as never,new URL('https://api.projectdiscovery.io/'))).toEqual({'X-API-Key':first});
    await runtime.credentials.save({slot:'pdcp',secret:second},session);
    expect(f.values.size).toBe(1);
    expect(runtime.identities.list().some(item=>item.id===identity)).toBe(false);
    await runtime.credentials.save({slot:'chaos',secret:second},session);
    const chaos=runtime.pluginConfig.intelligence.chaosIdentityId!;
    expect(await runtime.identities.headers(chaos as never,new URL('https://dns.projectdiscovery.io/dns/example.test'))).toEqual({Authorization:second});
    for(const path of await files(stateRoot)) {const content=await readFile(path);expect(content.includes(Buffer.from(first))).toBe(false);expect(content.includes(Buffer.from(second))).toBe(false);}
    expect(JSON.stringify(await runtime.snapshot())).not.toContain(second);
    await runtime.credentials.remove('pdcp',session);await runtime.credentials.remove('chaos',session);
    expect(f.values.size).toBe(0);expect(runtime.pluginConfig.intelligence.pdcpIdentityId).toBeUndefined();
  } finally {await runtime.close();}
});
it('keeps custom collector authentication host-bound and does not enable export on save',async()=>{
  const f=await fixture(),r=f.runtime,session=id<'SessionId'>(),key=`fixture-${id<'Key'>()}`;
  try {
    await r.updatePlugins(PluginConfigSchema.parse({...r.pluginConfig,telemetry:{enabled:false,endpoint:'https://collector.example.test/logs'}}),session);
    await r.credentials.save({slot:'telemetry',secret:key,header:'X-Collector-Key',bearer:false},session);
    const identity=r.pluginConfig.telemetry!.identityId!;
    expect(r.pluginConfig.telemetry!.enabled).toBe(false);
    expect(await r.identities.headers(identity as never,new URL('https://collector.example.test/logs'))).toEqual({'X-Collector-Key':key});
    await expect(r.identities.headers(identity as never,new URL('https://other.example.test/'))).rejects.toThrow('not authorized');
    await r.credentials.save({slot:'subfinder:shodan',secret:key},session);
    expect(r.pluginConfig.recon.sources).toContain('shodan');
    expect(await r.identities.apiKey(r.pluginConfig.recon.providerIdentities!.subfinder!.shodan! as never)).toBe(key);
    await r.credentials.remove('subfinder:shodan',session);expect(r.pluginConfig.recon.sources).not.toContain('shodan');
    await expect(r.credentials.save({slot:'telemetry',secret:key,header:'Host'},session)).rejects.toThrow('header');
    await expect(r.credentials.save({slot:'pdcp',secret:'invalid\nkey'},session)).rejects.toThrow('single-line');
    expect(f.values.size).toBe(1);
  }finally{await r.close();}
});
it('fails clearly when the secure store is unavailable and leaves no configured reference',async()=>{
  const f=await fixture({async get(){return undefined;},async set(){throw new Error('Secure store is locked');},async remove(){}});
  try {await expect(f.runtime.credentials.save({slot:'pdcp',secret:'fixture-value'},id<'SessionId'>())).rejects.toThrow('locked');
    expect(f.runtime.pluginConfig.intelligence.pdcpIdentityId).toBeUndefined();
  }finally{await f.runtime.close();}
});
it('delivers a saved key through the service broker to a local transport without redirects or credential output',async()=>{
  const f=await fixture(),r=f.runtime,session=id<'SessionId'>(),key=`fixture-${id<'Key'>()}`;
  try {
    await r.credentials.save({slot:'pdcp',secret:key},session);
    await r.updateSettings({...r.scope.scope,services:{...r.scope.scope.services,intelligence:[{host:'api.projectdiscovery.io',schemes:['https'],ports:[443],pathPrefixes:['/'],allowPrivateAddresses:false}]}},policyConfig,session);
    vi.spyOn(r.scope,'authorize').mockResolvedValue({url:new URL('https://api.projectdiscovery.io/v1/domain/associated'),rule:{} as never,addresses:['93.184.216.34']} as never);
    const seen:Record<string,string>[]=[];
    const client=new ServiceJsonClient(r.scope,r.identities,r.redactor,async(_grant,_input,headers)=>{seen.push(headers);return {status:200,headers:{},body:JSON.stringify({echo:key})};});
    const response=await client.send('https://api.projectdiscovery.io/v1/domain/associated','intelligence',null,AbortSignal.timeout(1000),r.pluginConfig.intelligence.pdcpIdentityId as never,'GET');
    expect(seen[0]?.['X-API-Key']).toBe(key);expect(JSON.stringify(response)).not.toContain(key);
  }finally{await r.close();}
});
it('persists crawl-only limits without changing shared policy and rejects excess depth',async()=>{
  const f=await fixture(),r=f.runtime,session=id<'SessionId'>();
  try {
    const scope=r.scope.version,policy=JSON.stringify(r.policyConfig);
    expect(r.crawlControls.seeds(['https://app.example.test/','https://outside.invalid/'])).toEqual({added:1});
    expect(r.crawlControls.snapshot()).toMatchObject({queued:1,running:false});
    const config={...r.frontier.config,maxPages:3,maxDepth:1};await r.updatePlugins({...r.pluginConfig,crawl:config},session);
    expect(r.crawlControls.snapshot()).toMatchObject({queued:0,config});
    expect(r.scope.version).toBe(scope);expect(JSON.stringify(r.policyConfig)).toBe(policy);
    expect((await stat(join(r.root,'plugins.json'))).mode & 0o777).toBe(0o600);
    await expect(r.updatePlugins({...r.pluginConfig,crawl:{...config,maxDepth:5}},session)).rejects.toMatchObject({code:'CRAWL_DEPTH'});
    await r.close();const restored=await PentestRuntime.open(f.config,testJudge);try{expect(restored.frontier.config).toEqual(config);}finally{await restored.close();}
  }finally{await r.close();}
});
it.skipIf(!process.env.DSH_TEST_NATIVE_PLUGIN_KEYS)('uses the native platform store for plugin save, restart, use and removal',async()=>{
  const native=nativeSecretProvider(resolve('native/keychain-helper')),f=await fixture(native),session=id<'SessionId'>(),key=`fixture-${id<'Key'>()}`;let runtime=f.runtime;
  try {
    await runtime.credentials.save({slot:'pdcp',secret:key},session);const identity=runtime.pluginConfig.intelligence.pdcpIdentityId!;
    await runtime.close();runtime=await PentestRuntime.open(f.config,testJudge);
    expect(await runtime.identities.headers(identity as never,new URL('https://api.projectdiscovery.io/'))).toEqual({'X-API-Key':key});
    await runtime.credentials.remove('pdcp',session);expect(await native.get(`${f.config.engagement.id}/${identity}`)).toBeUndefined();
  }finally{for(const item of runtime.identities.list())if(item.pluginCredential)await native.remove(`${f.config.engagement.id}/${item.id}`);await runtime.close();}
},35000);

it('retains a connected key when native-store removal fails, so the owner can retry',async()=>{
  const values=new Map<string,string>();let locked=false;
  const f=await fixture({async get(key){return values.get(key);},async set(key,value){values.set(key,value);},async remove(key){if(locked)throw new Error('Secure store is locked');values.delete(key);}});
  const session=id<'SessionId'>();
  try {
    await f.runtime.credentials.save({slot:'pdcp',secret:`fixture-${id<'Key'>()}`},session);const reference=f.runtime.pluginConfig.intelligence.pdcpIdentityId;
    locked=true;await expect(f.runtime.credentials.remove('pdcp',session)).rejects.toThrow('locked');
    expect(f.runtime.pluginConfig.intelligence.pdcpIdentityId).toBe(reference);expect(values.size).toBe(1);
    locked=false;await f.runtime.credentials.remove('pdcp',session);expect(values.size).toBe(0);
  }finally{await f.runtime.close();}
});

it('restores standalone bearer-token redaction for optional plugin judges without selecting the judge',async()=>{
  const f=await fixture(),session=id<'SessionId'>(),key=`fixture-${id<'Key'>()}`;let r=f.runtime;
  try {
    const kind=r.policyConfig.judge?.kind;
    await r.credentials.save({slot:'jev',secret:key},session);
    expect(r.policyConfig.judge?.kind).toBe(kind ?? 'selected-model');
    await r.close();r=await PentestRuntime.open(f.config,testJudge);
    const identity=r.policyConfig.judge!.identityId!;
    expect(await r.identities.headers(identity as never,new URL('https://api.typesafe.ai/'))).toEqual({Authorization:`Bearer ${key}`});
    expect(r.redactor.text(`echo=${key}`)).toBe('echo=[REDACTED]');
    await r.credentials.remove('jev',session);expect(f.values.size).toBe(0);
  }finally{await r.close();}
});
it('preserves a retired plugin key while another slot still references it, then removes it with its last binding',async()=>{
  const f=await fixture(),r=f.runtime,session=id<'SessionId'>();
  try {
    await r.credentials.save({slot:'pdcp',secret:`fixture-${id<'Key'>()}`},session);const original=r.pluginConfig.intelligence.pdcpIdentityId!;
    await r.updatePlugins({...r.pluginConfig,intelligence:{...r.pluginConfig.intelligence,chaosIdentityId:original}},session);
    await r.credentials.save({slot:'pdcp',secret:`fixture-${id<'Key'>()}`},session);
    await r.credentials.remove('pdcp',session);
    expect(r.identities.get(original as never).pluginCredential).toBe('pdcp');expect(f.values.size).toBe(1);
    await r.credentials.remove('chaos',session);expect(f.values.size).toBe(0);
    await r.credentials.save({slot:'uncover:shodan',secret:`fixture-${id<'Key'>()}`},session);
    expect(r.pluginConfig.recon.providerIdentities?.uncover?.shodan).toBeTruthy();
    await r.credentials.remove('uncover:shodan',session);expect(f.values.size).toBe(0);
  }finally{await r.close();}
});
