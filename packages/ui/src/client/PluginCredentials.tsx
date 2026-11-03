import { useState } from 'react';
import type { FormEvent } from 'react';
import css from './Panel.module.css';
export interface CredentialSnapshot {storage:string;entries:{slot:string;label:string;configured:boolean;destination:string}[]}
export function PluginCredentials({data,plugin,operate}:{data:CredentialSnapshot;plugin:string;operate(endpoint:string,payload:Record<string,unknown>):Promise<void>}) {
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const entries=data.entries.filter(entry=>plugin==='recon' ? ['pdcp','chaos','uncover:shodan'].includes(entry.slot)||entry.slot.startsWith('subfinder:') : plugin==='telemetry' ? entry.slot==='telemetry' : plugin==='engagement' ? entry.slot==='jev' : false);
  if(!entries.length) return null;
  const apply=async(endpoint:string,payload:Record<string,unknown>,message:string)=>{setBusy(true);setNotice('');try{await operate(endpoint,payload);setNotice(message);}catch(error){setNotice(error instanceof Error?error.message:'Credential operation failed');}finally{setBusy(false);}};
  const save=(event:FormEvent<HTMLFormElement>,slot?:string)=>{
    event.preventDefault();const form=event.currentTarget,values=new FormData(form);
    const credential={slot:slot??`subfinder:${String(values.get('provider')).trim().toLowerCase()}`,secret:String(values.get('secret')),
      ...(values.has('header')?{header:String(values.get('header')),bearer:values.get('format')==='bearer'}:{})};
    // Never retain or redisplay a submitted key, including when the store is locked.
    form.reset();void apply('credentials/save',{credential},'API key saved in the secure store.');
  };
  return <section aria-label="Plugin API keys">
    <h3>API keys</h3><p>Saved in {data.storage} on the machine running Djupleita. Values are never shown again. Saving does not contact the provider or change target scope.</p>
    {entries.map(entry=><article className={css.card} key={entry.slot}>
      <h4>{entry.label}</h4><p role="status">{entry.configured?'Configured · secure-store reference saved':'Not configured'}</p><small>{entry.destination || 'Configure the service endpoint first.'}</small>
      <form className={css.form} onSubmit={event=>save(event,entry.slot)}>
        <label>{entry.label} API key<input name="secret" type="password" required autoComplete="new-password" spellCheck={false}/></label>
        {(entry.slot==='telemetry'||entry.slot==='jev')&&<><label>Authentication header<input name="header" defaultValue="Authorization" required pattern="[A-Za-z][A-Za-z0-9-]*"/></label><label>Key format<select name="format" defaultValue="bearer"><option value="bearer">Bearer token</option><option value="raw">Raw API key</option></select></label></>}
        <button className={css.button} disabled={busy||!entry.destination}>{entry.configured?'Replace':'Save'} {entry.label} key</button>
      </form>
      {entry.configured&&<button className={css.button} disabled={busy} onClick={()=>{void apply('credentials/remove',{slot:entry.slot},'API key disconnected; managed secure-store record removed.');}}>Remove {entry.label} key</button>}
    </article>)}
    {plugin==='recon'&&<form className={css.form} onSubmit={event=>save(event)}>
      <h4>Add a Subfinder data source</h4><p>Use the provider name supported by Subfinder, such as shodan, virustotal or securitytrails. The source is enabled when its key is saved. For paired credentials use the provider’s id:secret format. Uncover currently uses Shodan.</p>
      <label>Subfinder provider<input name="provider" required pattern="[a-z][a-z0-9_-]{0,63}" autoComplete="off"/></label>
      <label>Provider API key<input name="secret" type="password" required autoComplete="new-password" spellCheck={false}/></label>
      <button className={css.button} disabled={busy}>Save Subfinder provider key</button>
    </form>}
    <p role="status">{notice}</p>
  </section>;
}
