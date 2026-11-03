import { useState } from 'react';
import type { FormEvent } from 'react';
import type { CrawlConfig, CrawlReport } from '../../../crawl/src/index.ts';
import css from './Panel.module.css';
export interface CrawlSnapshot {
  config: CrawlConfig; running: boolean; queued: number; visited: number; discovered: number; maxDepth: number;
  candidates: {url:string;depth:number;source:string}[]; rejected: {url:string;reason:string}[];
  report: CrawlReport | null; error: string | null;
}
export function CrawlPanel({ data, operate, openPolicy }: {data:CrawlSnapshot;operate(endpoint:string,payload:Record<string,unknown>):Promise<void>;openPolicy():void}) {
  const [busy,setBusy] = useState(false), [notice,setNotice] = useState('');
  const run = async (endpoint:string,payload:Record<string,unknown>,message:string) => {
    setBusy(true);setNotice('');
    try {await operate(endpoint,payload);setNotice(message);} catch(error) {setNotice(error instanceof Error ? error.message : 'Crawl operation failed');} finally {setBusy(false);}
  };
  const seeds = (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form=event.currentTarget, urls=String(new FormData(form).get('seeds')).split(/\s+/).filter(Boolean);
    void run('crawl/seeds',{urls},'Seeds checked against scope and added when permitted.');
  };
  const limits = (event:FormEvent<HTMLFormElement>) => {
    event.preventDefault();const values = new FormData(event.currentTarget);
    void run('crawl/settings',{config:Object.fromEntries(Object.keys(data.config).map(key=>[key,Number(values.get(key))]))},'Crawl limits saved; the previous queue was reset.');
  };
  return <section aria-label="Crawl controls">
    <h3>Scoped crawling</h3><p>Follow links from seed URLs using the shared engagement scope, action policy and request budget.</p>
    <button className={css.button} onClick={openPolicy}>Open shared engagement policy</button>
    <div className={css.stats}><span><strong>{data.queued}</strong> queued</span><span><strong>{data.visited}</strong> attempted</span><span><strong>{data.discovered}</strong> discovered</span></div>
    <p role="status">{data.running ? 'Crawl running' : data.report ? `Crawl stopped: ${data.report.stop} · ${data.report.visited} pages fetched` : 'Crawl idle'}</p>
    {data.error && <p role="alert">{data.error}</p>}
    <form className={css.form} onSubmit={seeds}><label>Seed URLs<textarea name="seeds" required placeholder="https://app.example.test/" spellCheck={false}/></label>
      <button className={css.button} disabled={busy || data.running}>Add seeds to queue</button></form>
    <div className={css.setupActions}><button className={css.button} disabled={busy || data.running || !data.queued} onClick={()=>{void run('crawl/start',{},'Crawl started.');}}>Start crawl</button>
      <button className={css.button} disabled={busy || !data.running} onClick={()=>{void run('crawl/stop',{},'Crawl stopped.');}}>Stop crawl</button></div>
    <p role="status">{notice}</p>
    <details><summary>Crawl limits</summary><form key={JSON.stringify(data.config)} className={css.form} onSubmit={limits}>
      {([['maxPages','Pages per run',1,10000],['maxDepth','Link depth',0,data.maxDepth],['maxQueued','Queue capacity',1,100000],['maxPerTemplate','Samples per endpoint template',1,100],['stalePageLimit','Pages without new surface before stopping',1,1000]] as const).map(([key,label,min,max])=><label key={key}>{label}<input name={key} type="number" min={min} max={max} defaultValue={data.config[key]} required/></label>)}
      <p>Applying limits stops the current crawl and clears the queue. Engagement budgets still apply.</p><button className={css.button} disabled={busy}>Apply crawl limits</button>
    </form></details>
    <details open><summary>Queued URLs ({data.queued})</summary>{data.candidates.length ? <ul>{data.candidates.map(candidate=><li key={candidate.url}><code>{candidate.url}</code> · depth {candidate.depth} · {candidate.source}</li>)}</ul> : <p>No queued URLs.</p>}{data.queued > data.candidates.length && <p>Showing the first {data.candidates.length} queued URLs.</p>}</details>
    {!!data.rejected.length && <details><summary>Recent rejected URLs</summary><ul>{data.rejected.map((item,index)=><li key={index}><code>{item.url}</code> · {item.reason}</li>)}</ul></details>}
    {!!data.report?.errors.length && <details><summary>Crawl errors</summary><ul>{data.report.errors.slice(-100).map((item,index)=><li key={index}><code>{item.url}</code> · {item.message}</li>)}</ul></details>}
  </section>;
}
