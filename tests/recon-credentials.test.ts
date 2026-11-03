import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ReconService } from '../packages/recon/src/index.ts';
import { PentestRuntime } from '../packages/dsh-plugin/src/runtime.ts';
import { engagement, policyConfig, testJudge } from './fixtures.ts';
import { id } from '../packages/contracts/src/index.ts';
it('delivers secure-store keys to confined CLI provider files, redacts output, and cleans files after success, failure or cancellation',async()=>{
  const root=await mkdtemp(join(tmpdir(),'djupleita-recon-keys-')),binary=join(root,'recon-fixture');
  execFileSync('cc',[resolve('tests/fixtures/recon-provider.c'),'-o',binary]);
  const values=new Map<string,string>(),key=`fixture-${id<'Key'>()}`,session=id<'SessionId'>();
  const runtime=await PentestRuntime.open({engagement:engagement(),policy:policyConfig,root,keychainHelper:'/unused',secrets:{async get(reference){return values.get(reference);},async set(reference,value){values.set(reference,value);},async remove(reference){values.delete(reference);}}},testJudge);
  try {
    await runtime.credentials.save({slot:'subfinder:shodan',secret:key},session);
    const sha256=createHash('sha256').update(await readFile(binary)).digest('hex');
    const runRoot=join(root,'runs');
    await runtime.credentials.save({slot:'pdcp',secret:key},session);
    await runtime.updatePlugins({...runtime.pluginConfig,recon:{...runtime.pluginConfig.recon,binaries:{subfinder:{path:binary,sha256},asnmap:{path:binary,sha256}}}},session);
    const config=runtime.pluginConfig.recon;
    const service=(sources:string[])=>new ReconService({...config,sources},runRoot,runtime.scope,runtime.engagement,runtime.graph,runtime.evidence,runtime.trajectories,runtime.redactor,chat=>runtime.crawl(chat),(identity,signal)=>runtime.identities.apiKey(identity as never,signal));
    const result=await service(['shodan']).run({tool:'subfinder',target:'app.example.test',depth:1},session,AbortSignal.timeout(10000));
    expect(JSON.stringify(result)).not.toContain(key);expect(JSON.stringify(result)).toContain('[REDACTED]');
    expect(result).toMatchObject({records:[{fileMode:0o600,providers:{shodan:['[REDACTED]']}}]});
    await expect(service(['failure']).run({tool:'subfinder',target:'app.example.test',depth:1},session,AbortSignal.timeout(10000))).rejects.toThrow('status 6');
    const abort=new AbortController();
    const pending=service(['pause']).run({tool:'subfinder',target:'app.example.test',depth:1},session,abort.signal);
    const cancelled=expect(pending).rejects.toThrow();
    for(let i=0;i<100;i++) {if((await readdir(runRoot)).length===3)break;await new Promise(resolve=>setTimeout(resolve,10));}
    abort.abort();await cancelled;
    for(const run of await readdir(runRoot))await expect(readFile(join(runRoot,run,'provider-config.yaml'))).rejects.toMatchObject({code:'ENOENT'});
    const asnmap=await runtime.recon().run({tool:'asnmap',target:'app.example.test',depth:1},session,AbortSignal.timeout(10000));
    expect(asnmap).toMatchObject({records:[{pdcpApiKey:'[REDACTED]'}]});
    await runtime.credentials.remove('pdcp',session);
    await expect(runtime.recon().run({tool:'asnmap',target:'app.example.test',depth:1},session,AbortSignal.timeout(10000))).rejects.toThrow('Save a ProjectDiscovery Cloud key');
    expect(JSON.stringify(await runtime.trajectories.read(session))).not.toContain(key);
  }finally{await runtime.close();await rm(root,{recursive:true,force:true});}
},30000);
